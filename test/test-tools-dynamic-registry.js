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

import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

t.test('factory: missing api still exposes tools — handler returns backend_unavailable', async () => {
  __testing.resetMemCache();
  const pluginApi = makePluginApi();
  setupDynamicRegistry(pluginApi, {
    getApiForAgent: () => null,
    getAgentId: () => 'agent-no-api',
    log,
  });
  const tools = pluginApi._getFactory()({ agentId: 'agent-no-api' });
  assert(tools.length > 0, 'tools still exposed');
  const r = await tools[0].handler({ conversation_id: 'c', local_path: '/tmp/x' });
  assertEqual(r.ok, false, 'handler returns failure');
  assertEqual(r.error, 'backend_unavailable', 'reports backend_unavailable');
});

t.test('handler invokes api.dispatchTool with dispatchId UUID', async () => {
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
  await tools[0].handler({ foo: 'bar' });
  assert(captured, 'dispatchTool was called');
  assertEqual(captured.name, 'kinthai_terminal_test', 'tool name forwarded');
  assertEqual(captured.params.foo, 'bar', 'params forwarded');
  assert(/^[0-9a-f-]{36}$/.test(captured.dispatchId), 'dispatchId is UUID v4');
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

t.test('throws if pluginApi missing required methods', () => {
  let threw = false;
  try {
    setupDynamicRegistry({}, { getApiForAgent: () => null, getAgentId: () => null });
  } catch (err) {
    threw = err.message.includes('pluginApi');
  }
  assert(threw, 'should reject malformed pluginApi');
});

// ── Run ──────────────────────────────────────────────────────────────────────

await setup();
const ok = await t.run();
await teardown();
process.exit(ok ? 0 : 1);
