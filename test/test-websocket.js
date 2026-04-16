/**
 * Tests for WebSocket connection protocol.
 * 测试 WebSocket 连接协议。
 */

import WebSocket from 'ws';
import * as mockServer from './mock-server.js';
import { TestRunner, assert, assertEqual } from './helpers.js';

const t = new TestRunner('WebSocket Protocol Tests');

const WS_URL = 'ws://localhost:18900/ws';
let testApiKey;

async function setupAgent() {
  const res = await fetch('http://localhost:18900/api/v1/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'ws-test@example.com',
      openclaw_machine_id: 'ws-machine',
      openclaw_agent_id: 'ws-agent',
    }),
  });
  const data = await res.json();
  testApiKey = data.api_key;
}

function connectWs(token, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('WS connect timeout')); }, timeout);
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token || testApiKey)}`);
    // Buffer messages received before any waitForMessage listener is attached
    ws._msgQueue = [];
    ws._msgListeners = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      // Check if any listener wants this message
      for (let i = 0; i < ws._msgListeners.length; i++) {
        const { filter, resolve: res, timer: t } = ws._msgListeners[i];
        if (!filter || filter(msg)) {
          clearTimeout(t);
          ws._msgListeners.splice(i, 1);
          res(msg);
          return;
        }
      }
      // No listener matched — queue it
      ws._msgQueue.push(msg);
    });
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitForMessage(ws, filter, timeout = 5000) {
  // Check queued messages first
  for (let i = 0; i < ws._msgQueue.length; i++) {
    const msg = ws._msgQueue[i];
    if (!filter || filter(msg)) {
      ws._msgQueue.splice(i, 1);
      return Promise.resolve(msg);
    }
  }
  // Wait for future message
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeout);
    ws._msgListeners.push({ filter, resolve, timer });
  });
}

// ── Test: server sends hello on connect ──────────────────────────────────────

t.test('server sends hello event on connection', async () => {
  const ws = await connectWs();
  try {
    const msg = await waitForMessage(ws, m => m.event === 'hello');
    assertEqual(msg.event, 'hello', 'should be hello event');
    assert(msg.server, 'should have server field');
  } finally {
    ws.close();
  }
});

// ── Test: identify with valid api_key → identified ───────────────────────────

t.test('identify with valid api_key returns identified', async () => {
  const ws = await connectWs();
  try {
    // Wait for hello
    await waitForMessage(ws, m => m.event === 'hello');

    // Send identify
    ws.send(JSON.stringify({ event: 'identify', api_key: testApiKey, plugin_version: '2.5.1' }));

    const msg = await waitForMessage(ws, m => m.event === 'identified');
    assertEqual(msg.event, 'identified', 'should be identified');
    assert(msg.user_id, 'should have user_id');
  } finally {
    ws.close();
  }
});

// ── Test: identify with invalid api_key → error + close ──────────────────────

t.test('identify with invalid api_key returns error', async () => {
  const ws = await connectWs();
  try {
    await waitForMessage(ws, m => m.event === 'hello');

    ws.send(JSON.stringify({ event: 'identify', api_key: 'bad-key' }));

    const msg = await waitForMessage(ws, m => m.event === 'error');
    assertEqual(msg.event, 'error', 'should be error');
    assert(msg.message.includes('Invalid'), 'should mention invalid');
  } finally {
    ws.close();
  }
});

// ── Test: client ping → server pong ──────────────────────────────────────────

t.test('client ping gets server pong', async () => {
  const ws = await connectWs();
  try {
    await waitForMessage(ws, m => m.event === 'hello');
    ws.send(JSON.stringify({ event: 'identify', api_key: testApiKey }));
    await waitForMessage(ws, m => m.event === 'identified');

    const ts = Date.now();
    ws.send(JSON.stringify({ event: 'ping', ts }));

    const pong = await waitForMessage(ws, m => m.event === 'pong');
    assertEqual(pong.ts, ts, 'pong should echo timestamp');
  } finally {
    ws.close();
  }
});

// ── Test: server can push message.new to connected client ────────────────────

t.test('server pushes message.new to identified client', async () => {
  const ws = await connectWs();
  try {
    await waitForMessage(ws, m => m.event === 'hello');
    ws.send(JSON.stringify({ event: 'identify', api_key: testApiKey }));
    await waitForMessage(ws, m => m.event === 'identified');

    // Use mock server control API to send event
    const sent = mockServer.sendWsEvent(testApiKey, {
      event: 'message.new',
      conversation_id: 'conv-test-001',
      message_id: 'msg-push-001',
      sender_id: 'user-human-001',
      sender_type: 'human',
      content: 'Hello agent!',
    });
    assert(sent, 'sendWsEvent should succeed');

    const msg = await waitForMessage(ws, m => m.event === 'message.new');
    assertEqual(msg.event, 'message.new', 'should be message.new');
    assertEqual(msg.content, 'Hello agent!', 'content should match');
    assertEqual(msg.sender_type, 'human', 'should be from human');
  } finally {
    ws.close();
  }
});

// ── Test: server can push admin.command ───────────────────────────────────────

t.test('server pushes admin.command to client', async () => {
  const ws = await connectWs();
  try {
    await waitForMessage(ws, m => m.event === 'hello');
    ws.send(JSON.stringify({ event: 'identify', api_key: testApiKey }));
    await waitForMessage(ws, m => m.event === 'identified');

    mockServer.sendWsEvent(testApiKey, {
      event: 'admin.command',
      command: 'check',
      request_id: 'req-001',
    });

    const msg = await waitForMessage(ws, m => m.event === 'admin.command');
    assertEqual(msg.command, 'check', 'command should be check');
    assertEqual(msg.request_id, 'req-001', 'request_id should match');
  } finally {
    ws.close();
  }
});

// ── Test: server can push admin.file_request ─────────────────────────────────

t.test('server pushes admin.file_request to client', async () => {
  const ws = await connectWs();
  try {
    await waitForMessage(ws, m => m.event === 'hello');
    ws.send(JSON.stringify({ event: 'identify', api_key: testApiKey }));
    await waitForMessage(ws, m => m.event === 'identified');

    mockServer.sendWsEvent(testApiKey, {
      event: 'admin.file_request',
      request_id: 'freq-001',
      paths: ['SOUL.md', 'AGENTS.md'],
    });

    const msg = await waitForMessage(ws, m => m.event === 'admin.file_request');
    assertEqual(msg.request_id, 'freq-001', 'request_id should match');
    assert(msg.paths.includes('SOUL.md'), 'should include SOUL.md');
  } finally {
    ws.close();
  }
});

// ── Test: server can push role.updated ───────────────────────────────────────

t.test('server pushes role.updated event', async () => {
  const ws = await connectWs();
  try {
    await waitForMessage(ws, m => m.event === 'hello');
    ws.send(JSON.stringify({ event: 'identify', api_key: testApiKey }));
    await waitForMessage(ws, m => m.event === 'identified');

    mockServer.sendWsEvent(testApiKey, {
      event: 'role.updated',
      conversation_id: 'conv-test-001',
    });

    const msg = await waitForMessage(ws, m => m.event === 'role.updated');
    assertEqual(msg.conversation_id, 'conv-test-001', 'conv_id should match');
  } finally {
    ws.close();
  }
});

// ── Test: multiple clients connected simultaneously ──────────────────────────

t.test('multiple agents connect simultaneously', async () => {
  // Register second agent
  const res = await fetch('http://localhost:18900/api/v1/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'ws-test@example.com',
      openclaw_machine_id: 'ws-machine',
      openclaw_agent_id: 'ws-agent-2',
    }),
  });
  const data = await res.json();
  const key2 = data.api_key;

  const ws1 = await connectWs(testApiKey);
  const ws2 = await connectWs(key2);
  try {
    // Both get hello
    await waitForMessage(ws1, m => m.event === 'hello');
    await waitForMessage(ws2, m => m.event === 'hello');

    // Both identify
    ws1.send(JSON.stringify({ event: 'identify', api_key: testApiKey }));
    ws2.send(JSON.stringify({ event: 'identify', api_key: key2 }));

    await waitForMessage(ws1, m => m.event === 'identified');
    await waitForMessage(ws2, m => m.event === 'identified');

    // Send event only to ws1
    mockServer.sendWsEvent(testApiKey, { event: 'ping', ts: 111 });
    const pong1 = await waitForMessage(ws1, m => m.event === 'ping' && m.ts === 111);
    assertEqual(pong1.ts, 111, 'ws1 should get the ping');

    // ws2 should NOT get that event (it's targeted)
    // Send to ws2
    mockServer.sendWsEvent(key2, { event: 'ping', ts: 222 });
    const pong2 = await waitForMessage(ws2, m => m.event === 'ping' && m.ts === 222);
    assertEqual(pong2.ts, 222, 'ws2 should get its own ping');
  } finally {
    ws1.close();
    ws2.close();
  }
});

// ── Test: reconnect after close ──────────────────────────────────────────────

t.test('client can reconnect after server closes connection', async () => {
  const ws1 = await connectWs();
  await waitForMessage(ws1, m => m.event === 'hello');
  ws1.close();

  // Wait for close to propagate
  await new Promise(r => setTimeout(r, 100));

  // Reconnect
  const ws2 = await connectWs();
  try {
    const hello = await waitForMessage(ws2, m => m.event === 'hello');
    assertEqual(hello.event, 'hello', 'should get hello on reconnect');

    ws2.send(JSON.stringify({ event: 'identify', api_key: testApiKey }));
    const id = await waitForMessage(ws2, m => m.event === 'identified');
    assert(id.user_id, 'should identify successfully on reconnect');
  } finally {
    ws2.close();
  }
});

// ── Run ──────────────────────────────────────────────────────────────────────

await mockServer.start();
await setupAgent();
const ok = await t.run();
await mockServer.stop();
process.exit(ok ? 0 : 1);
