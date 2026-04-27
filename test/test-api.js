/**
 * Tests for KinthaiApi HTTP client.
 * 测试 KinthaiApi HTTP 客户端。
 */

import * as mockServer from './mock-server.js';
import { TestRunner, assert, assertEqual } from './helpers.js';
import { KinthaiApi } from '../src/api.js';

const t = new TestRunner('API Client Tests');

let testApiKey;

// ── Setup: register a test agent ─────────────────────────────────────────────

async function setupAgent() {
  const res = await fetch('http://localhost:18900/api/v1/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'api-test@example.com',
      openclaw_machine_id: 'test-machine-api',
      openclaw_agent_id: 'api-agent',
    }),
  });
  const data = await res.json();
  testApiKey = data.api_key;
}

// ── Tests ────────────────────────────────────────────────────────────────────

t.test('getMe returns agent info', async () => {
  const api = new KinthaiApi('http://localhost:18900', testApiKey, console);
  const me = await api.getMe();

  assert(me.user_id, 'should have user_id');
  assertEqual(me.openclaw_agent_id, 'api-agent', 'agent_id');
  assertEqual(me.email, 'api-test@example.com', 'email');
});

t.test('getMe with invalid token throws 401', async () => {
  const api = new KinthaiApi('http://localhost:18900', 'invalid-token', console);
  let threw = false;
  try {
    await api.getMe();
  } catch (err) {
    threw = true;
    assert(err.message.includes('401'), 'should be 401 error');
  }
  assert(threw, 'should throw on invalid token');
});

t.test('getConversation returns conversation info', async () => {
  const api = new KinthaiApi('http://localhost:18900', testApiKey, console);
  const conv = await api.getConversation('conv-test-001');

  assertEqual(conv.id, 'conv-test-001', 'conv id');
  assertEqual(conv.type, 'dm', 'conv type');
});

t.test('getMembers returns member list', async () => {
  const api = new KinthaiApi('http://localhost:18900', testApiKey, console);
  const members = await api.getMembers('conv-test-001');

  assert(Array.isArray(members), 'should be array');
  assert(members.length >= 2, 'should have at least 2 members');
  assert(members.some(m => m.display_name === 'TestHuman'), 'should have TestHuman');
});

t.test('getMessages returns empty initially', async () => {
  const api = new KinthaiApi('http://localhost:18900', testApiKey, console);
  const resp = await api.getMessages('conv-test-001', 10);

  assert(resp.messages !== undefined, 'should have messages field');
  assertEqual(resp.messages.length, 0, 'should be empty initially');
});

t.test('sendMessage posts and returns message', async () => {
  const api = new KinthaiApi('http://localhost:18900', testApiKey, console);
  const msg = await api.sendMessage('conv-test-001', {
    content: 'Hello from test!',
  });

  assert(msg.message_id, 'should have message_id');
  assertEqual(msg.content, 'Hello from test!', 'content');
  assertEqual(msg.sender_type, 'agent', 'sender_type');
});

t.test('getMessages returns sent message', async () => {
  const api = new KinthaiApi('http://localhost:18900', testApiKey, console);
  const resp = await api.getMessages('conv-test-001', 10);

  assert(resp.messages.length >= 1, 'should have at least 1 message');
  assert(resp.messages.some(m => m.content === 'Hello from test!'), 'should find our message');
});

t.test('getRoleContext returns system prompt', async () => {
  const api = new KinthaiApi('http://localhost:18900', testApiKey, console);
  const ctx = await api.getRoleContext('conv-test-001');

  assert(ctx.system_prompt, 'should have system_prompt');
});

t.test('reportModel succeeds', async () => {
  const api = new KinthaiApi('http://localhost:18900', testApiKey, console);
  // First send a message to get a message_id
  const msg = await api.sendMessage('conv-test-001', { content: 'model test' });

  const result = await api.reportModel(msg.message_id, 'gpt-4', { input_tokens: 100 });
  assert(result.ok, 'should return ok');
});

t.test('reportModel forwards session to backend', async () => {
  const api = new KinthaiApi('http://localhost:18900', testApiKey, console);
  const msg = await api.sendMessage('conv-test-001', { content: 'session test' });

  const result = await api.reportModel(
    msg.message_id,
    'gpt-4',
    { input_tokens: 100 },
    { session_key: 'agent:test:kinthai:direct:99' },
  );

  assert(result.ok, 'should return ok');
  assertEqual(
    result.received?.session?.session_key,
    'agent:test:kinthai:direct:99',
    'mock server should receive session.session_key in body',
  );
});

t.test('reportModel omits session field when not provided', async () => {
  const api = new KinthaiApi('http://localhost:18900', testApiKey, console);
  const msg = await api.sendMessage('conv-test-001', { content: 'no session test' });

  const result = await api.reportModel(msg.message_id, 'gpt-4', { input_tokens: 100 });
  assert(result.received?.session === undefined, 'body should not contain session');
});

t.test('getConversation 404 for unknown conv', async () => {
  const api = new KinthaiApi('http://localhost:18900', testApiKey, console);
  let threw = false;
  try {
    await api.getConversation('nonexistent');
  } catch (err) {
    threw = true;
    assert(err.message.includes('404'), 'should be 404');
  }
  assert(threw, 'should throw for unknown conversation');
});

// ── Run ──────────────────────────────────────────────────────────────────────

await mockServer.start();
await setupAgent();
const ok = await t.run();
await mockServer.stop();
process.exit(ok ? 0 : 1);
