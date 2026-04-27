/**
 * Mock KinthAI backend — HTTP + WebSocket on port 18900.
 * 模拟 KinthAI 后端 — HTTP + WebSocket，端口 18900。
 *
 * In-memory storage. No external dependencies beyond Node.js built-ins + ws.
 * 内存存储。除 Node.js 内置模块和 ws 外无外部依赖。
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const PORT = 18900;

// ── In-memory state ─────────────────────────────────────────────────────────

const agents = new Map();       // api_key → { user_id, email, machine_id, agent_id, display_name }
const conversations = new Map(); // conv_id → { id, name, type, members[], messages[] }
const files = new Map();        // file_id → { name, buffer, extract }
const wsClients = new Map();    // api_key → ws

// v3.0.0 agent-tools state
const continuationStore = new Map();   // continuation_id → { agentApiKey, tool, params, dispatchId, expiresAt }
const rateLimitedAgents = new Set();   // api_keys whose dispatches return 429
let toolsManifestOverride = null;      // optional override; null = use built-in
const dispatchObserver = { count: 0, lastDispatchId: null, byTool: new Map() };

let pluginLatestVersion = '2.5.1';

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function parseAuth(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function findAgent(apiKey) {
  return agents.get(apiKey) || null;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req);
  return JSON.parse(buf.toString());
}

// ── Seed data ────────────────────────────────────────────────────────────────

function seedData() {
  // Create a test conversation
  const convId = 'conv-test-001';
  const botUserId = 'user-bot-001';
  const humanUserId = 'user-human-001';

  conversations.set(convId, {
    id: convId,
    name: 'Test Chat',
    type: 'dm',
    members: [
      { id: humanUserId, display_name: 'TestHuman', role: 'member' },
      { id: botUserId, display_name: 'TestAgent', role: 'member' },
    ],
    messages: [],
  });

  // Create a group conversation
  const groupId = 'conv-group-001';
  conversations.set(groupId, {
    id: groupId,
    name: 'Test Group',
    type: 'group',
    members: [
      { id: humanUserId, display_name: 'TestHuman', role: 'member' },
      { id: botUserId, display_name: 'TestAgent', role: 'member' },
      { id: 'user-human-002', display_name: 'AnotherHuman', role: 'member' },
    ],
    messages: [],
  });
}

// ── HTTP Routes ──────────────────────────────────────────────────────────────

function handleRegister(req, res, body) {
  const { email, openclaw_machine_id, openclaw_agent_id } = body;

  if (!email || !openclaw_machine_id || !openclaw_agent_id) {
    return jsonResponse(res, 400, { message: 'Missing required fields' });
  }

  // Check for existing registration (same machine + agent)
  for (const [key, agent] of agents) {
    if (agent.machine_id === openclaw_machine_id && agent.agent_id === openclaw_agent_id) {
      // 409 with token recovery
      return jsonResponse(res, 409, {
        message: 'Already registered',
        api_key: key,
        kk_agent_id: agent.user_id,
      });
    }
  }

  // Check owner mismatch (same machine, different email)
  for (const [, agent] of agents) {
    if (agent.machine_id === openclaw_machine_id && agent.email !== email) {
      return jsonResponse(res, 403, { message: 'Machine owner mismatch' });
    }
  }

  const apiKey = `kk_test_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const userId = `agent-${openclaw_agent_id}-${Date.now()}`;

  agents.set(apiKey, {
    user_id: userId,
    email,
    machine_id: openclaw_machine_id,
    agent_id: openclaw_agent_id,
    display_name: openclaw_agent_id,
  });

  return jsonResponse(res, 201, {
    api_key: apiKey,
    kk_agent_id: userId,
    user_id: userId,
  });
}

function handleGetMe(req, res) {
  const apiKey = parseAuth(req);
  const agent = findAgent(apiKey);
  if (!agent) return jsonResponse(res, 401, { message: 'Invalid token' });

  return jsonResponse(res, 200, {
    user_id: agent.user_id,
    display_name: agent.display_name,
    openclaw_agent_id: agent.agent_id,
    email: agent.email,
  });
}

function handleGetConversation(req, res, convId) {
  const apiKey = parseAuth(req);
  if (!findAgent(apiKey)) return jsonResponse(res, 401, { message: 'Invalid token' });

  const conv = conversations.get(convId);
  if (!conv) return jsonResponse(res, 404, { message: 'Conversation not found' });

  return jsonResponse(res, 200, { id: conv.id, name: conv.name, type: conv.type });
}

function handleGetMembers(req, res, convId) {
  const apiKey = parseAuth(req);
  if (!findAgent(apiKey)) return jsonResponse(res, 401, { message: 'Invalid token' });

  const conv = conversations.get(convId);
  if (!conv) return jsonResponse(res, 404, { message: 'Conversation not found' });

  return jsonResponse(res, 200, conv.members);
}

function handleGetMessages(req, res, convId, url) {
  const apiKey = parseAuth(req);
  if (!findAgent(apiKey)) return jsonResponse(res, 401, { message: 'Invalid token' });

  const conv = conversations.get(convId);
  if (!conv) return jsonResponse(res, 404, { message: 'Conversation not found' });

  const params = new URL(url, `http://localhost:${PORT}`).searchParams;
  const limit = parseInt(params.get('limit') || '30', 10);
  const msgs = conv.messages.slice(-limit);

  return jsonResponse(res, 200, { messages: msgs });
}

function handlePostMessage(req, res, convId, body) {
  const apiKey = parseAuth(req);
  const agent = findAgent(apiKey);
  if (!agent) return jsonResponse(res, 401, { message: 'Invalid token' });

  const conv = conversations.get(convId);
  if (!conv) return jsonResponse(res, 404, { message: 'Conversation not found' });

  const msg = {
    message_id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    conversation_id: convId,
    sender_id: agent.user_id,
    sender_type: 'agent',
    content: body.content || '',
    file_ids: body.file_ids || [],
    metadata: body.metadata || {},
    created_at: new Date().toISOString(),
  };

  conv.messages.push(msg);

  return jsonResponse(res, 201, msg);
}

function handleReportModel(req, res, body) {
  return jsonResponse(res, 200, { ok: true, received: body });
}

function handleGetRoleContext(req, res, convId) {
  const apiKey = parseAuth(req);
  if (!findAgent(apiKey)) return jsonResponse(res, 401, { message: 'Invalid token' });

  return jsonResponse(res, 200, {
    system_prompt: 'You are a helpful assistant.',
    conversation_id: convId,
  });
}

function handlePluginLatestVersion(req, res) {
  const apiKey = parseAuth(req);
  if (!findAgent(apiKey)) return jsonResponse(res, 401, { message: 'Invalid token' });

  return jsonResponse(res, 200, {
    version: pluginLatestVersion,
    files: [],
  });
}

function handleAdminCommandResult(req, res, body) {
  const apiKey = parseAuth(req);
  if (!findAgent(apiKey)) return jsonResponse(res, 401, { message: 'Invalid token' });

  return jsonResponse(res, 200, { ok: true });
}

function handleFileUpload(req, res) {
  // Simplified: store raw body as file
  const apiKey = parseAuth(req);
  if (!findAgent(apiKey)) return jsonResponse(res, 401, { message: 'Invalid token' });

  const fileId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  files.set(fileId, { name: 'uploaded-file', buffer: Buffer.alloc(0), extract: '' });

  return jsonResponse(res, 201, { file_id: fileId, url: `/api/v1/files/${fileId}` });
}

// ── Agent Tools (v3.0.0) ─────────────────────────────────────────────────────

const BUILTIN_MANIFEST = {
  manifest_version: 1,
  generated_at: '2026-04-27T00:00:00Z',
  tools: [
    {
      name: 'kinthai_upload_file',
      description: 'mock upload tool — uploads a local file to a conversation',
      parameters: {
        type: 'object',
        properties: {
          conversation_id: { type: 'string' },
          local_path: { type: 'string' },
          caption: { type: 'string' },
        },
        required: ['conversation_id', 'local_path'],
      },
    },
  ],
};

function pruneExpiredContinuations() {
  const now = Date.now();
  for (const [id, slot] of continuationStore) {
    if (slot.expiresAt <= now) continuationStore.delete(id);
  }
}

function handleAgentToolsManifest(req, res) {
  const apiKey = parseAuth(req);
  if (!findAgent(apiKey)) return jsonResponse(res, 401, { error: 'unauthorized' });
  return jsonResponse(res, 200, toolsManifestOverride || BUILTIN_MANIFEST);
}

function handleAgentToolsDispatch(req, res, body) {
  const apiKey = parseAuth(req);
  const agent = findAgent(apiKey);
  if (!agent) return jsonResponse(res, 401, { error: 'unauthorized' });

  if (rateLimitedAgents.has(apiKey)) {
    res.setHeader('Retry-After', '1');
    return jsonResponse(res, 429, { ok: false, error: 'rate_limited', hint: 'Too many requests' });
  }

  const { tool, params } = body || {};
  const dispatchId = req.headers['x-dispatch-id'] || null;
  if (!tool || typeof params !== 'object') {
    return jsonResponse(res, 200, {
      ok: false,
      error: 'schema_invalid',
      hint: 'Body must include {tool, params}.',
    });
  }

  dispatchObserver.count += 1;
  dispatchObserver.lastDispatchId = dispatchId;
  dispatchObserver.byTool.set(tool, (dispatchObserver.byTool.get(tool) || 0) + 1);

  // kinthai_upload_file → continuation: read_local_file
  if (tool === 'kinthai_upload_file') {
    if (!params.conversation_id || !params.local_path) {
      return jsonResponse(res, 200, {
        ok: false,
        error: 'schema_invalid',
        hint: 'Missing conversation_id or local_path',
        expected_schema: BUILTIN_MANIFEST.tools[0].parameters,
      });
    }
    const id = `k_${Math.random().toString(36).slice(2, 14)}`;
    continuationStore.set(id, {
      agentApiKey: apiKey,
      tool, params, dispatchId,
      stage: 'awaiting-file',
      expiresAt: Date.now() + 5 * 60_000,
    });
    return jsonResponse(res, 200, {
      continuation: { id, type: 'read_local_file', path: params.local_path },
    });
  }

  // kinthai_terminal_ok_test → terminal ok, no continuation
  if (tool === 'kinthai_terminal_ok_test') {
    return jsonResponse(res, 200, { ok: true, data: { ack: 'no_continuation' } });
  }

  // kinthai_force_fail_test → terminal fail (used to verify agent doesn't lie)
  if (tool === 'kinthai_force_fail_test') {
    return jsonResponse(res, 200, {
      ok: false,
      error: 'forced_failure',
      hint: 'This is a forced failure for testing.',
    });
  }

  return jsonResponse(res, 200, { ok: false, error: 'tool_not_found', hint: `Unknown tool ${tool}` });
}

function handleAgentToolsContinue(req, res, body) {
  const apiKey = parseAuth(req);
  const agent = findAgent(apiKey);
  if (!agent) return jsonResponse(res, 401, { error: 'unauthorized' });

  pruneExpiredContinuations();

  const { continuation_id, result } = body || {};
  if (!continuation_id) {
    return jsonResponse(res, 200, { ok: false, error: 'schema_invalid', hint: 'continuation_id required' });
  }

  const slot = continuationStore.get(continuation_id);
  if (!slot) {
    return jsonResponse(res, 410, { ok: false, error: 'continuation_expired', hint: 'Operation timed out; retry the original tool call.' });
  }
  if (slot.agentApiKey !== apiKey) {
    // Anti-theft: don't even hint that the continuation exists for someone else
    return jsonResponse(res, 410, { ok: false, error: 'continuation_expired', hint: 'Operation timed out; retry the original tool call.' });
  }

  // Single-use
  continuationStore.delete(continuation_id);

  // Plugin reported a local failure (path_denied, path_too_large, etc.) — fold into terminal error
  if (result && result.ok === false) {
    return jsonResponse(res, 200, {
      ok: false,
      error: result.error || 'plugin_local_error',
      hint: result.message || 'Plugin reported a local failure.',
    });
  }

  // Success — pretend we created a file + message
  const fileId = `file-${Math.random().toString(36).slice(2, 8)}`;
  const messageId = `msg-${Math.random().toString(36).slice(2, 8)}`;
  return jsonResponse(res, 200, {
    ok: true,
    data: { file_id: fileId, message_id: messageId },
  });
}

function handleFileDownload(req, res, fileId) {
  const apiKey = parseAuth(req);
  if (!findAgent(apiKey)) return jsonResponse(res, 401, { message: 'Invalid token' });

  const file = files.get(fileId);
  if (!file) return jsonResponse(res, 404, { message: 'File not found' });

  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  res.end(file.buffer);
}

function handleFileExtract(req, res, fileId) {
  const apiKey = parseAuth(req);
  if (!findAgent(apiKey)) return jsonResponse(res, 401, { message: 'Invalid token' });

  const file = files.get(fileId);
  if (!file) return jsonResponse(res, 404, { message: 'File not found' });

  return jsonResponse(res, 200, { text: file.extract || '' });
}

// ── HTTP Server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = req.url;
  const method = req.method;

  try {
    // POST /api/v1/register
    if (method === 'POST' && url === '/api/v1/register') {
      return handleRegister(req, res, await readJson(req));
    }

    // GET /api/v1/users/me
    if (method === 'GET' && url === '/api/v1/users/me') {
      return handleGetMe(req, res);
    }

    // GET /api/v1/plugin/latest-version
    if (method === 'GET' && url === '/api/v1/plugin/latest-version') {
      return handlePluginLatestVersion(req, res);
    }

    // POST /api/v1/admin/command-result
    if (method === 'POST' && url === '/api/v1/admin/command-result') {
      return handleAdminCommandResult(req, res, await readJson(req));
    }

    // POST /api/v1/files/upload
    if (method === 'POST' && url === '/api/v1/files/upload') {
      return handleFileUpload(req, res);
    }

    // Conversation routes
    const convMatch = url.match(/^\/api\/v1\/conversations\/([^/]+)(\/.*)?/);
    if (convMatch) {
      const convId = convMatch[1];
      const sub = convMatch[2] || '';

      if (method === 'GET' && sub === '') {
        return handleGetConversation(req, res, convId);
      }
      if (method === 'GET' && sub === '/members') {
        return handleGetMembers(req, res, convId);
      }
      if (method === 'GET' && sub.startsWith('/messages')) {
        return handleGetMessages(req, res, convId, url);
      }
      if (method === 'POST' && sub === '/messages') {
        return handlePostMessage(req, res, convId, await readJson(req));
      }
      if (method === 'GET' && sub === '/role-context') {
        return handleGetRoleContext(req, res, convId);
      }
    }

    // Agent tools (v3.0.0)
    if (method === 'GET' && url === '/api/v1/agent/tools/manifest') {
      return handleAgentToolsManifest(req, res);
    }
    if (method === 'POST' && url === '/api/v1/agent/tools/dispatch') {
      return handleAgentToolsDispatch(req, res, await readJson(req));
    }
    if (method === 'POST' && url === '/api/v1/agent/tools/continue') {
      return handleAgentToolsContinue(req, res, await readJson(req));
    }

    // Message routes
    const msgMatch = url.match(/^\/api\/v1\/messages\/([^/]+)\/model$/);
    if (method === 'PUT' && msgMatch) {
      return handleReportModel(req, res, await readJson(req));
    }

    // File routes
    const fileMatch = url.match(/^\/api\/v1\/files\/([^/]+)(\/extract)?$/);
    if (fileMatch) {
      const fileId = fileMatch[1];
      if (fileMatch[2] === '/extract') {
        return handleFileExtract(req, res, fileId);
      }
      if (method === 'GET') {
        return handleFileDownload(req, res, fileId);
      }
    }

    // 404
    jsonResponse(res, 404, { message: `Not found: ${method} ${url}` });
  } catch (err) {
    jsonResponse(res, 500, { message: err.message });
  }
});

// ── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const token = params.get('token');

  let agentInfo = findAgent(token);
  let identified = false;

  // Send hello
  ws.send(JSON.stringify({ event: 'hello', server: 'mock-kinthai', version: '1.0.0' }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // identify
    if (msg.event === 'identify') {
      agentInfo = findAgent(msg.api_key || token);
      if (agentInfo) {
        identified = true;
        wsClients.set(msg.api_key || token, ws);
        ws.send(JSON.stringify({ event: 'identified', user_id: agentInfo.user_id }));
      } else {
        ws.send(JSON.stringify({ event: 'error', message: 'Invalid api_key' }));
        ws.close();
      }
      return;
    }

    // pong
    if (msg.event === 'pong') {
      return;
    }

    // ping from client
    if (msg.event === 'ping') {
      ws.send(JSON.stringify({ event: 'pong', ts: msg.ts }));
      return;
    }
  });

  // Server-side ping every 30s
  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ event: 'ping', ts: Date.now() }));
    }
  }, 30_000);

  ws.on('close', () => {
    clearInterval(pingTimer);
    if (token) wsClients.delete(token);
  });
});

// ── Control API (for tests to manipulate state) ──────────────────────────────

// Expose internal state for test assertions and manipulation
export {
  agents,
  conversations,
  files,
  wsClients,
  server,
  wss,
  PORT,
  continuationStore,
  dispatchObserver,
};

export function reset() {
  agents.clear();
  conversations.clear();
  files.clear();
  for (const ws of wsClients.values()) ws.close();
  wsClients.clear();
  continuationStore.clear();
  rateLimitedAgents.clear();
  toolsManifestOverride = null;
  dispatchObserver.count = 0;
  dispatchObserver.lastDispatchId = null;
  dispatchObserver.byTool.clear();
  seedData();
}

// ── Test helpers for agent-tools state ───────────────────────────────────────

export function setRateLimited(apiKey, on) {
  if (on) rateLimitedAgents.add(apiKey);
  else rateLimitedAgents.delete(apiKey);
}

export function setToolsManifest(manifest) {
  toolsManifestOverride = manifest;
}

export function expireContinuation(continuationId) {
  continuationStore.delete(continuationId);
}

export function getDispatchStats() {
  return {
    count: dispatchObserver.count,
    lastDispatchId: dispatchObserver.lastDispatchId,
    byTool: Object.fromEntries(dispatchObserver.byTool),
  };
}

export function sendWsEvent(apiKey, event) {
  const ws = wsClients.get(apiKey);
  if (ws?.readyState === ws?.OPEN) {
    ws.send(JSON.stringify(event));
    return true;
  }
  return false;
}

export function addMessage(convId, msg) {
  const conv = conversations.get(convId);
  if (!conv) return null;
  const full = {
    message_id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    conversation_id: convId,
    sender_type: 'human',
    created_at: new Date().toISOString(),
    ...msg,
  };
  conv.messages.push(full);
  return full;
}

export async function start() {
  seedData();
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`[mock] KinthAI mock server listening on http://localhost:${PORT}`);
      resolve();
    });
  });
}

export async function stop() {
  for (const ws of wsClients.values()) ws.close();
  wsClients.clear();
  wss.close();
  return new Promise((resolve) => server.close(resolve));
}

// Run standalone if called directly
if (process.argv[1]?.endsWith('mock-server.js')) {
  start();
}
