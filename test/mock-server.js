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

  const fileId = `file-${Date.now()}`;
  files.set(fileId, { name: 'uploaded-file', buffer: Buffer.alloc(0), extract: '' });

  return jsonResponse(res, 201, { file_id: fileId, url: `/api/v1/files/${fileId}` });
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
};

export function reset() {
  agents.clear();
  conversations.clear();
  files.clear();
  for (const ws of wsClients.values()) ws.close();
  wsClients.clear();
  seedData();
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
