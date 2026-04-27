/**
 * Tests for KinthaiApi agent-tools methods (v3.0.0).
 *
 * Hits the mock server's /api/v1/agent/tools/* endpoints. Covers:
 *  - fetchToolManifest happy path + 401
 *  - dispatchTool happy path (terminal + continuation)
 *  - dispatchTool 401 → unauthorized
 *  - dispatchTool 429 backoff (eventually returns rate_limited or succeeds)
 *  - dispatchTool 200 + ok:false body passes through
 *  - continueTool 410 → continuation_expired
 *  - X-Dispatch-Id header is propagated
 */

import * as mockServer from './mock-server.js';
import { TestRunner, assert, assertEqual } from './helpers.js';
import { KinthaiApi } from '../src/api.js';

const t = new TestRunner('Agent Tools API Tests');

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
let agentApiKey;

async function setupAgent() {
  mockServer.reset();
  const res = await fetch('http://localhost:18900/api/v1/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'tools-test@example.com',
      openclaw_machine_id: 'test-machine-tools',
      openclaw_agent_id: 'tools-agent',
    }),
  });
  const data = await res.json();
  agentApiKey = data.api_key;
}

t.test('fetchToolManifest returns v1 manifest', async () => {
  const api = new KinthaiApi('http://localhost:18900', agentApiKey, log);
  const m = await api.fetchToolManifest();
  assertEqual(m.manifest_version, 1, 'version 1');
  assert(Array.isArray(m.tools), 'tools is array');
  assert(m.tools.some((tool) => tool.name === 'kinthai_upload_file'), 'has upload tool');
});

t.test('fetchToolManifest 401 throws with code unauthorized', async () => {
  const api = new KinthaiApi('http://localhost:18900', 'bad-token', log);
  let code = null;
  try { await api.fetchToolManifest(); }
  catch (err) { code = err.code; }
  assertEqual(code, 'unauthorized', 'should be unauthorized error');
});

t.test('dispatchTool happy path returns continuation', async () => {
  const api = new KinthaiApi('http://localhost:18900', agentApiKey, log);
  const r = await api.dispatchTool('kinthai_upload_file', {
    conversation_id: 'conv-test-001',
    local_path: '/tmp/test.txt',
  }, 'dispatch-id-1');
  assert(r.continuation, 'returns continuation');
  assertEqual(r.continuation.type, 'read_local_file', 'type read_local_file');
  assertEqual(r.continuation.path, '/tmp/test.txt', 'path forwarded');
});

t.test('dispatchTool terminal ok pass-through', async () => {
  const api = new KinthaiApi('http://localhost:18900', agentApiKey, log);
  const r = await api.dispatchTool('kinthai_terminal_ok_test', {}, 'd2');
  assertEqual(r.ok, true, 'ok true');
  assertEqual(r.data.ack, 'no_continuation', 'data forwarded');
});

t.test('dispatchTool 200 + ok:false pass-through (forced fail)', async () => {
  const api = new KinthaiApi('http://localhost:18900', agentApiKey, log);
  const r = await api.dispatchTool('kinthai_force_fail_test', {}, 'd3');
  assertEqual(r.ok, false, 'ok false');
  assertEqual(r.error, 'forced_failure', 'error passed through');
  assert(r.hint, 'has hint');
});

t.test('dispatchTool unknown tool returns tool_not_found terminal', async () => {
  const api = new KinthaiApi('http://localhost:18900', agentApiKey, log);
  const r = await api.dispatchTool('kinthai_does_not_exist', {}, 'd4');
  assertEqual(r.ok, false, 'ok false');
  assertEqual(r.error, 'tool_not_found', 'tool_not_found code');
});

t.test('dispatchTool schema_invalid when required params missing', async () => {
  const api = new KinthaiApi('http://localhost:18900', agentApiKey, log);
  const r = await api.dispatchTool('kinthai_upload_file', {}, 'd5');
  assertEqual(r.ok, false, 'ok false');
  assertEqual(r.error, 'schema_invalid', 'schema_invalid');
  assert(r.expected_schema || r.hint, 'has hint or expected_schema');
});

t.test('dispatchTool 401 with bad token returns unauthorized', async () => {
  const api = new KinthaiApi('http://localhost:18900', 'bad-token', log);
  const r = await api.dispatchTool('kinthai_upload_file', {
    conversation_id: 'conv-test-001', local_path: '/tmp/test.txt',
  }, 'd-bad');
  assertEqual(r.ok, false, 'ok false');
  assertEqual(r.error, 'unauthorized', 'unauthorized');
});

t.test('dispatchTool 429 backs off and eventually returns rate_limited after retries', async () => {
  const api = new KinthaiApi('http://localhost:18900', agentApiKey, log);
  mockServer.setRateLimited(agentApiKey, true);
  const start = Date.now();
  const r = await api.dispatchTool('kinthai_terminal_ok_test', {}, 'd-rate');
  const elapsed = Date.now() - start;
  mockServer.setRateLimited(agentApiKey, false);
  assertEqual(r.ok, false, 'ok false after retries exhausted');
  assertEqual(r.error, 'rate_limited', 'rate_limited code');
  // 3 retries with Retry-After: 1s each → ~3s minimum (mock returns Retry-After: 1)
  // Be lenient here — we just want to verify there was *some* delay.
  assert(elapsed >= 1000, `should have backed off at least 1s, got ${elapsed}ms`);
});

t.test('continueTool happy path returns terminal ok', async () => {
  const api = new KinthaiApi('http://localhost:18900', agentApiKey, log);
  // First dispatch to get a continuation_id
  const dr = await api.dispatchTool('kinthai_upload_file', {
    conversation_id: 'conv-test-001', local_path: '/tmp/test.txt',
  }, 'd-cont-1');
  const cid = dr.continuation.id;
  const cr = await api.continueTool(cid, { content_b64: Buffer.from('hi').toString('base64') });
  assertEqual(cr.ok, true, 'continue ok');
  assert(cr.data?.file_id, 'has file_id');
  assert(cr.data?.message_id, 'has message_id');
});

t.test('continueTool with bogus id → continuation_expired', async () => {
  const api = new KinthaiApi('http://localhost:18900', agentApiKey, log);
  const r = await api.continueTool('k_does_not_exist', {});
  assertEqual(r.ok, false, 'ok false');
  assertEqual(r.error, 'continuation_expired', 'continuation_expired');
});

t.test('continueTool with another agent\'s id → continuation_expired (anti-theft)', async () => {
  const apiA = new KinthaiApi('http://localhost:18900', agentApiKey, log);
  // Register a second agent
  const res2 = await fetch('http://localhost:18900/api/v1/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'tools-test-2@example.com',
      openclaw_machine_id: 'test-machine-tools-2',
      openclaw_agent_id: 'tools-agent-2',
    }),
  });
  const { api_key: apiKeyB } = await res2.json();
  const apiB = new KinthaiApi('http://localhost:18900', apiKeyB, log);

  const dr = await apiA.dispatchTool('kinthai_upload_file', {
    conversation_id: 'conv-test-001', local_path: '/tmp/test.txt',
  }, 'd-theft');
  const cid = dr.continuation.id;

  const stolen = await apiB.continueTool(cid, { content_b64: 'aGFjaw==' });
  assertEqual(stolen.ok, false, 'anti-theft must fail');
  assertEqual(stolen.error, 'continuation_expired', 'anti-theft maps to expired');
});

t.test('X-Dispatch-Id header is propagated', async () => {
  const api = new KinthaiApi('http://localhost:18900', agentApiKey, log);
  await api.dispatchTool('kinthai_terminal_ok_test', {}, 'unique-disp-id-xyz');
  const stats = mockServer.getDispatchStats();
  assertEqual(stats.lastDispatchId, 'unique-disp-id-xyz', 'X-Dispatch-Id reached server');
});

// ── Run ──────────────────────────────────────────────────────────────────────

await mockServer.start();
await setupAgent();
const ok = await t.run();
await mockServer.stop();
process.exit(ok ? 0 : 1);
