/**
 * Tests for src/tools/dynamic-registry.js
 *
 * Drives the factory + before_agent_start hook with mock pluginApi and a
 * fake KinthaiApi. No backend mock server needed (we hand-craft the
 * fetchToolManifest behavior).
 *
 * Covers: factory called multiple times returns fresh tool list; cold path
 * (no cache) returns default-manifest; hook fetch failure → factory keeps
 * stale or default; manifest_version != 1 falls back; mtime invalidates
 * mem cache; handler dispatches via the resolved api; missing api still
 * exposes tools (returns backend_unavailable when invoked).
 */

import { mkdtemp, rm, writeFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_BASE } from '../src/storage.js';
import { TestRunner, assert, assertEqual } from './helpers.js';
import {
  setupDynamicRegistry,
  __testing,
} from '../src/tools/dynamic-registry.js';

const t = new TestRunner('Dynamic Registry Tests');

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

let originalHome;
let fakeHome;

async function setup() {
  originalHome = process.env.HOME;
  fakeHome = await mkdtemp(join(tmpdir(), 'oc-reg-home-'));
  process.env.HOME = fakeHome;
  __testing.resetMemCache();
}

async function teardown() {
  process.env.HOME = originalHome;
  await rm(fakeHome, { recursive: true, force: true });
}

function makePluginApi() {
  const hooks = new Map();
  let registeredFactory = null;
  return {
    on: (event, handler) => { hooks.set(event, handler); },
    registerTool: (factory) => { registeredFactory = factory; },
    _trigger: (event, data, ctx) => {
      const h = hooks.get(event);
      return h ? h(data, ctx) : undefined;
    },
    _getFactory: () => registeredFactory,
  };
}

function makeKinthaiApi({ manifest, dispatchResult } = {}) {
  return {
    fetchToolManifest: async () => manifest ?? {
      manifest_version: 1,
      generated_at: '2026-04-27T00:00:00Z',
      tools: [{
        name: 'kinthai_test_tool',
        description: 'fetched',
        parameters: { type: 'object', properties: {}, required: [] },
      }],
    },
    dispatchTool: async (name, params, dispatchId) =>
      dispatchResult ?? { ok: true, data: { name, params, dispatchId } },
    continueTool: async () => ({ ok: true }),
    uploadFile: async () => ({ file_id: 'file-mock' }),
  };
}

t.test('cold path (no cache) returns default-manifest tools', () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  setupDynamicRegistry(pluginApi, {
    getApiForAgent: () => null,
    getAgentId: () => 'agent-cold',
    log,
  });
  const tools = pluginApi._getFactory()({ agentId: 'agent-cold' });
  assert(Array.isArray(tools), 'returns array');
  assert(tools.length > 0, 'tools not empty (uses default manifest)');
  assertEqual(tools[0].name, 'kinthai_upload_file', 'default tool present');
});

t.test('factory called twice returns fresh tools array each time', () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  setupDynamicRegistry(pluginApi, {
    getApiForAgent: () => null,
    getAgentId: () => 'agent-1',
    log,
  });
  const factory = pluginApi._getFactory();
  const a = factory({ agentId: 'agent-1' });
  const b = factory({ agentId: 'agent-1' });
  assert(a !== b, 'returns a fresh array');
  assertEqual(a.length, b.length, 'same shape');
});

t.test('hook fetches manifest and writes per-agent cache', async () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  const api = makeKinthaiApi();
  setupDynamicRegistry(pluginApi, {
    getApiForAgent: () => ({ api }),
    getAgentId: (ctx) => ctx?.agentId,
    log,
  });
  await pluginApi._trigger('before_agent_start', { prompt: 'test' }, { agentId: 'agent-2' });
  const cachedPath = __testing.cachePath('agent-2');
  const s = await stat(cachedPath);
  assert(s.isFile(), 'cache file written');
  const factory = pluginApi._getFactory();
  const tools = factory({ agentId: 'agent-2' });
  assertEqual(tools[0].name, 'kinthai_test_tool', 'factory reads fetched manifest');
});

t.test('hook fetch failure: factory still returns tools (stale or default)', async () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  const api = {
    fetchToolManifest: async () => { throw new Error('network down'); },
    dispatchTool: async () => ({ ok: false, error: 'backend_unavailable' }),
    continueTool: async () => ({ ok: true }),
    uploadFile: async () => ({ file_id: 'file-mock' }),
  };
  setupDynamicRegistry(pluginApi, {
    getApiForAgent: () => ({ api }),
    getAgentId: (ctx) => ctx?.agentId,
    log,
  });
  await pluginApi._trigger('before_agent_start', { prompt: 'x' }, { agentId: 'agent-fail' });
  const tools = pluginApi._getFactory()({ agentId: 'agent-fail' });
  assert(tools.length > 0, 'factory still returns tools (default manifest fallback)');
});

t.test('manifest_version != 1 falls back to default', async () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  const api = makeKinthaiApi({ manifest: { manifest_version: 99, tools: [] } });
  setupDynamicRegistry(pluginApi, {
    getApiForAgent: () => ({ api }),
    getAgentId: (ctx) => ctx?.agentId,
    log,
  });
  await pluginApi._trigger('before_agent_start', {}, { agentId: 'agent-v99' });
  const tools = pluginApi._getFactory()({ agentId: 'agent-v99' });
  assertEqual(tools[0].name, 'kinthai_upload_file', 'fell back to default');
});

t.test('factory: missing api still exposes tools — execute returns backend_unavailable', async () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  setupDynamicRegistry(pluginApi, {
    getApiForAgent: () => null,
    getAgentId: () => 'agent-no-api',
    log,
  });
  const tools = pluginApi._getFactory()({ agentId: 'agent-no-api' });
  assert(tools.length > 0, 'tools still exposed');
  const r = await tools[0].execute('tcid-1', { conversation_id: 'c', local_path: '/tmp/x' });
  assert(Array.isArray(r.content), 'AgentToolResult.content is array');
  const inner = JSON.parse(r.content[0].text);
  assertEqual(inner.ok, false, 'execute reports failure');
  assertEqual(inner.error, 'backend_unavailable', 'reports backend_unavailable');
  assertEqual(r.details.ok, false, 'details.ok mirrors final.ok');
});

t.test('execute invokes api.dispatchTool with dispatchId UUID', async () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  let captured = null;
  const api = {
    fetchToolManifest: async () => ({
      manifest_version: 1,
      generated_at: '2026-04-27T00:00:00Z',
      tools: [{
        name: 'kinthai_terminal_test',
        description: 'test',
        parameters: { type: 'object', properties: {}, required: [] },
      }],
    }),
    dispatchTool: async (name, params, dispatchId) => {
      captured = { name, params, dispatchId };
      return { ok: true, data: { ok: 1 } };
    },
    continueTool: async () => ({ ok: true }),
    uploadFile: async () => ({ file_id: 'file-mock' }),
  };
  setupDynamicRegistry(pluginApi, {
    getApiForAgent: () => ({ api }),
    getAgentId: (ctx) => ctx?.agentId,
    log,
  });
  await pluginApi._trigger('before_agent_start', {}, { agentId: 'agent-disp' });
  const tools = pluginApi._getFactory()({ agentId: 'agent-disp' });
  const r = await tools[0].execute('tcid-disp', { foo: 'bar' });
  assert(captured, 'dispatchTool was called');
  assertEqual(captured.name, 'kinthai_terminal_test', 'tool name forwarded');
  assertEqual(captured.params.foo, 'bar', 'params forwarded');
  assert(/^[0-9a-f-]{36}$/.test(captured.dispatchId), 'dispatchId is UUID v4');
  assert(Array.isArray(r.content), 'returns AgentToolResult.content array');
  assertEqual(r.details.toolCallId, 'tcid-disp', 'toolCallId echoed in details');
});

t.test('cache mtime change invalidates mem cache', async () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  let manifestVer = 'A';
  const api = {
    fetchToolManifest: async () => ({
      manifest_version: 1,
      generated_at: '2026-04-27T00:00:00Z',
      tools: [{
        name: `kinthai_${manifestVer}`,
        description: 'v',
        parameters: { type: 'object', properties: {}, required: [] },
      }],
    }),
    dispatchTool: async () => ({ ok: true }),
    continueTool: async () => ({ ok: true }),
    uploadFile: async () => ({ file_id: 'file-mock' }),
  };
  setupDynamicRegistry(pluginApi, {
    getApiForAgent: () => ({ api }),
    getAgentId: (ctx) => ctx?.agentId,
    log,
  });
  await pluginApi._trigger('before_agent_start', {}, { agentId: 'agent-mtime' });
  const t1 = pluginApi._getFactory()({ agentId: 'agent-mtime' });
  assertEqual(t1[0].name, 'kinthai_A', 'first version cached');

  // Sleep enough so file mtime advances (most filesystems have ms-resolution mtime,
  // but some have second-resolution — wait > 1s to be safe).
  await new Promise((r) => setTimeout(r, 1100));

  manifestVer = 'B';
  await pluginApi._trigger('before_agent_start', {}, { agentId: 'agent-mtime' });
  const t2 = pluginApi._getFactory()({ agentId: 'agent-mtime' });
  assertEqual(t2[0].name, 'kinthai_B', 'mem cache invalidated by mtime change');
});

t.test('agentId with unsafe characters is sanitized into cache filename', () => {
  const p = __testing.cachePath('agent/with;weird..chars');
  assert(p.endsWith('manifest-agent_with_weird__chars.json'), `bad path: ${p}`);
});

// ── AgentTool shape regression (v3.0.1 bug-v3.0.0-tool-shape) ────────────────
// OpenClaw runtime calls tool.execute(toolCallId, params, signal?, onUpdate?)
// and expects {content:[{type:"text",text}], details}. Earlier v3.0.0 shipped
// {handler:(params)=>...} which crashed with "tool.execute is not a function"
// when an agent actually invoked the tool. These tests guard that shape.

t.test('shape: factory tools have execute (not handler)', () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  setupDynamicRegistry(pluginApi, {
    getApiForAgent: () => null,
    getAgentId: () => 'agent-shape',
    log,
  });
  const tools = pluginApi._getFactory()({ agentId: 'agent-shape' });
  for (const tool of tools) {
    assertEqual(typeof tool.execute, 'function', `tool ${tool.name} must have execute(...) function`);
    assertEqual(typeof tool.handler, 'undefined', `tool ${tool.name} must NOT have legacy 'handler' property`);
    assertEqual(typeof tool.name, 'string', `tool.name string`);
    assertEqual(typeof tool.label, 'string', `tool.label string (AgentTool requires it)`);
    assertEqual(typeof tool.description, 'string', `tool.description string`);
    assert(tool.parameters && typeof tool.parameters === 'object', 'tool.parameters object');
  }
});

t.test('shape: execute signature is (toolCallId, params, ...)', async () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  let observed = null;
  const api = {
    fetchToolManifest: async () => ({
      manifest_version: 1,
      generated_at: '2026-04-27T00:00:00Z',
      tools: [{
        name: 'kinthai_sig_test',
        description: 'sig',
        parameters: { type: 'object', properties: {}, required: [] },
      }],
    }),
    dispatchTool: async (n, p, d) => { observed = { n, p, d }; return { ok: true, data: {} }; },
    continueTool: async () => ({ ok: true }),
    uploadFile: async () => ({ file_id: 'file-mock' }),
  };
  setupDynamicRegistry(pluginApi, {
    getApiForAgent: () => ({ api }),
    getAgentId: (ctx) => ctx?.agentId,
    log,
  });
  await pluginApi._trigger('before_agent_start', {}, { agentId: 'agent-sig' });
  const tools = pluginApi._getFactory()({ agentId: 'agent-sig' });

  // Wrong: call without toolCallId → params goes to first arg position
  // Right: (toolCallId, params)
  await tools[0].execute('call-id-xyz', { hello: 'world' });
  assertEqual(observed.p.hello, 'world', 'params landed in 2nd positional, not 1st');
  // Make sure nothing broke when signal/onUpdate are omitted
  assert(observed.n === 'kinthai_sig_test', 'tool name reached dispatch');
});

t.test('shape: execute returns AgentToolResult with content + details', async () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  const api = {
    fetchToolManifest: async () => ({
      manifest_version: 1,
      generated_at: '2026-04-27T00:00:00Z',
      tools: [{
        name: 'kinthai_result_shape_test',
        description: 'rs',
        parameters: { type: 'object', properties: {}, required: [] },
      }],
    }),
    dispatchTool: async () => ({ ok: true, data: { file_id: 'f-1', message_id: 'm-1' } }),
    continueTool: async () => ({ ok: true }),
    uploadFile: async () => ({ file_id: 'file-mock' }),
  };
  setupDynamicRegistry(pluginApi, {
    getApiForAgent: () => ({ api }),
    getAgentId: (ctx) => ctx?.agentId,
    log,
  });
  await pluginApi._trigger('before_agent_start', {}, { agentId: 'agent-result' });
  const tools = pluginApi._getFactory()({ agentId: 'agent-result' });

  const r = await tools[0].execute('tcid', {});
  assert(Array.isArray(r.content), 'content is array');
  assertEqual(r.content.length, 1, 'one content block');
  assertEqual(r.content[0].type, 'text', 'content is text');
  assertEqual(typeof r.content[0].text, 'string', 'text is string');

  // Inner should be JSON-parsable into the {ok, data, ...} shape
  const inner = JSON.parse(r.content[0].text);
  assertEqual(inner.ok, true, 'inner.ok preserved');
  assertEqual(inner.data.file_id, 'f-1', 'inner.data preserved');

  assert(r.details && typeof r.details === 'object', 'details present');
  assertEqual(r.details.tool, 'kinthai_result_shape_test', 'details.tool');
  assertEqual(r.details.toolCallId, 'tcid', 'details.toolCallId echoed');
  assertEqual(r.details.ok, true, 'details.ok mirrors inner.ok');
});

t.test('shape: dispatch throw surfaces as AgentToolResult ok:false (not exception)', async () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  const api = {
    fetchToolManifest: async () => ({
      manifest_version: 1,
      generated_at: '2026-04-27T00:00:00Z',
      tools: [{
        name: 'kinthai_throw_test',
        description: 't',
        parameters: { type: 'object', properties: {}, required: [] },
      }],
    }),
    dispatchTool: async () => { throw new Error('connection reset'); },
    continueTool: async () => ({ ok: true }),
    uploadFile: async () => ({ file_id: 'file-mock' }),
  };
  setupDynamicRegistry(pluginApi, {
    getApiForAgent: () => ({ api }),
    getAgentId: (ctx) => ctx?.agentId,
    log,
  });
  await pluginApi._trigger('before_agent_start', {}, { agentId: 'agent-throw' });
  const tools = pluginApi._getFactory()({ agentId: 'agent-throw' });

  // Must NOT throw — must return ok:false wrapped in AgentToolResult shape
  let threw = false;
  let result = null;
  try { result = await tools[0].execute('t-throw', {}); }
  catch { threw = true; }
  assert(!threw, 'execute must not throw — runtime expects a Promise<AgentToolResult>');
  const inner = JSON.parse(result.content[0].text);
  assertEqual(inner.ok, false, 'inner.ok=false');
  assertEqual(inner.error, 'backend_unavailable', 'maps to backend_unavailable');
});

t.test('throws if pluginApi missing required methods', () => {
  let threw = false;
  try {
    setupDynamicRegistry({}, { getApiForAgent: () => null, getAgentId: () => null });
  } catch (err) {
    threw = err.message.includes('pluginApi');
  }
  assert(threw, 'should reject malformed pluginApi');
});

// ── T-Plugin: ensureLocalFile + local_path injection ─────────────────────────

t.test('T-Plugin-1: cache hit — returns existing path, downloadFile not called', async () => {
  const wsBase = await mkdtemp(join(tmpdir(), 'oc-tp1-'));
  try {
    const filesDir = join(wsBase, 'conv_tp1', 'files');
    await mkdir(filesDir, { recursive: true });
    await writeFile(join(filesDir, 'file_yyy_photo.jpg'), Buffer.from('fake'));

    let downloadCalled = 0;
    const api = { downloadFile: async () => { downloadCalled++; return Buffer.from(''); } };
    const result = await __testing.ensureLocalFile(api, 'file_yyy', 'conv_tp1', 'photo.jpg', log, wsBase);

    assertEqual(result, join(filesDir, 'file_yyy_photo.jpg'), 'returns cached path');
    assertEqual(downloadCalled, 0, 'downloadFile not called on cache hit');
  } finally {
    await rm(wsBase, { recursive: true, force: true });
  }
});

t.test('T-Plugin-2: cache miss — downloads, writes file, returns correct path', async () => {
  const wsBase = await mkdtemp(join(tmpdir(), 'oc-tp2-'));
  try {
    const filesDir = join(wsBase, 'conv_tp2', 'files');
    await mkdir(filesDir, { recursive: true });

    let downloadCalled = 0;
    const fakeBuffer = Buffer.from('x'.repeat(1024));
    const api = { downloadFile: async () => { downloadCalled++; return fakeBuffer; } };
    const result = await __testing.ensureLocalFile(api, 'file_zzz', 'conv_tp2', 'image.jpg', log, wsBase);

    assertEqual(downloadCalled, 1, 'downloadFile called once');
    assertEqual(result, join(filesDir, 'file_zzz_image.jpg'), 'returns correct local path');
    const s = await stat(result);
    assert(s.isFile(), 'file written to disk');
    assertEqual(s.size, 1024, 'file size matches buffer');
  } finally {
    await rm(wsBase, { recursive: true, force: true });
  }
});

t.test('T-Plugin-3: ensureLocalFile — download failure propagates as thrown error', async () => {
  const wsBase = await mkdtemp(join(tmpdir(), 'oc-tp3-'));
  try {
    const api = { downloadFile: async () => { throw new Error('network reset'); } };
    let threw = false;
    try {
      await __testing.ensureLocalFile(api, 'file_aaa', 'conv_tp3', 'photo.jpg', log, wsBase);
    } catch (err) {
      threw = true;
      assert(err.message.includes('network reset'), 'original error propagates');
    }
    assert(threw, 'ensureLocalFile throws on download failure');
  } finally {
    await rm(wsBase, { recursive: true, force: true });
  }
});

t.test('T-Plugin-3b: makeExecute — download fail degrades, download_url preserved, no exception', async () => {
  __testing.resetMemCache();
  const convId = 'conv-tp3b-' + Date.now();
  let warnMsg = '';
  const testLog = { info: () => {}, debug: () => {}, error: () => {}, warn: (m) => { warnMsg = m; } };

  const pluginApi = makePluginApi();
  const api = {
    fetchToolManifest: async () => ({
      manifest_version: 1, generated_at: '2026-05-03T00:00:00Z',
      tools: [{ name: 'kinthai_read_file', description: 'r', parameters: { type: 'object', properties: {}, required: [] } }],
    }),
    dispatchTool: async () => ({
      ok: true,
      data: { file_id: 'file_aaa', original_name: 'photo.jpg', download_url: '/api/v1/files/file_aaa', conversation_id: convId },
    }),
    continueTool: async () => ({ ok: true }),
    downloadFile: async () => { throw new Error('connection reset'); },
  };
  setupDynamicRegistry(pluginApi, { getApiForAgent: () => ({ api }), getAgentId: (ctx) => ctx?.agentId, log: testLog });
  await pluginApi._trigger('before_agent_start', {}, { agentId: 'agent-tp3b' });
  const tools = pluginApi._getFactory()({ agentId: 'agent-tp3b' });

  let threw = false;
  let r;
  try { r = await tools[0].execute('tcid-3b', {}); } catch { threw = true; }

  assert(!threw, 'execute must not throw');
  const inner = JSON.parse(r.content[0].text);
  assertEqual(inner.ok, true, 'result ok:true (dispatch succeeded)');
  assert(!inner.data?.local_path, 'local_path absent after download failure');
  assert(inner.data?.download_url, 'download_url still present for agent fallback');
  assert(warnMsg.includes('[KK-T033]'), 'KK-T033 warn log emitted');
  assert(warnMsg.includes('file_aaa'), 'file_id in warn log');

  await rm(join(WORKSPACE_BASE, convId), { recursive: true, force: true });
});

t.test('T-Plugin-4: non-image result (no download_url) — injection skipped, result unchanged', async () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  const api = {
    fetchToolManifest: async () => ({
      manifest_version: 1, generated_at: '2026-05-03T00:00:00Z',
      tools: [{ name: 'kinthai_read_file', description: 'r', parameters: { type: 'object', properties: {}, required: [] } }],
    }),
    dispatchTool: async () => ({ ok: true, data: { text: 'file contents here' } }),
    continueTool: async () => ({ ok: true }),
    downloadFile: async () => { throw new Error('should not be called'); },
  };
  setupDynamicRegistry(pluginApi, { getApiForAgent: () => ({ api }), getAgentId: (ctx) => ctx?.agentId, log });
  await pluginApi._trigger('before_agent_start', {}, { agentId: 'agent-tp4' });
  const tools = pluginApi._getFactory()({ agentId: 'agent-tp4' });
  const r = await tools[0].execute('tcid-4', {});
  const inner = JSON.parse(r.content[0].text);
  assertEqual(inner.ok, true, 'ok:true');
  assertEqual(inner.data.text, 'file contents here', 'text data preserved');
  assert(!inner.data.local_path, 'no local_path injected for text result');
});

t.test('T-Plugin-5: idempotent cache — second call hits cache, downloadFile called only once', async () => {
  const wsBase = await mkdtemp(join(tmpdir(), 'oc-tp5-'));
  try {
    const filesDir = join(wsBase, 'conv_tp5', 'files');
    await mkdir(filesDir, { recursive: true });

    let downloadCalled = 0;
    const api = { downloadFile: async () => { downloadCalled++; return Buffer.from('y'.repeat(512)); } };

    const p1 = await __testing.ensureLocalFile(api, 'file_zzz', 'conv_tp5', 'image.jpg', log, wsBase);
    const p2 = await __testing.ensureLocalFile(api, 'file_zzz', 'conv_tp5', 'image.jpg', log, wsBase);

    assertEqual(downloadCalled, 1, 'downloadFile called exactly once across both calls');
    assertEqual(p1, p2, 'both calls return same path');
  } finally {
    await rm(wsBase, { recursive: true, force: true });
  }
});

// ── Run ──────────────────────────────────────────────────────────────────────

await setup();
const ok = await t.run();
await teardown();
process.exit(ok ? 0 : 1);
