/**
 * Tests for agent registration flow.
 * 测试 agent 注册流程。
 */

import { readFile } from 'node:fs/promises';
import * as mockServer from './mock-server.js';
import { createTempOpenClaw, TestRunner, assert, assertEqual } from './helpers.js';

const t = new TestRunner('Registration Tests');

// ── Test: new agent registers successfully ──────────────────────────────────

t.test('new agent registers and gets api_key', async () => {
  const env = await createTempOpenClaw({ agents: ['agent-a'] });
  try {
    const { autoRegisterAgents } = await import('../src/register.js');
    const tokens = await autoRegisterAgents(
      'http://localhost:18900',
      'test@example.com',
      env.tokensFilePath,
      console,
    );

    assert(tokens !== null, 'tokens should not be null');
    assert(tokens['agent-a'], 'agent-a should have a token');
    assert(tokens['agent-a'].startsWith('kk_test_'), 'token should start with kk_test_');

    // Verify .tokens.json was written
    const saved = JSON.parse(await readFile(env.tokensFilePath, 'utf8'));
    assert(saved['agent-a'], '.tokens.json should contain agent-a');
    assertEqual(saved._email, 'test@example.com', '_email metadata');
    assertEqual(saved._kinthai_url, 'http://localhost:18900', '_kinthai_url metadata');
    assert(saved._machine_id, '_machine_id should be set');
  } finally {
    await env.cleanup();
  }
});

// ── Test: already registered agent is skipped ────────────────────────────────

t.test('already registered agent is skipped (no network call for machineId)', async () => {
  const env = await createTempOpenClaw({ agents: ['agent-a'] });
  try {
    const { autoRegisterAgents } = await import('../src/register.js');

    // First registration
    await autoRegisterAgents('http://localhost:18900', 'test@example.com', env.tokensFilePath, console);

    // Second call — should skip, no machineId fetch needed
    const tokens2 = await autoRegisterAgents('http://localhost:18900', 'test@example.com', env.tokensFilePath, console);

    assert(tokens2 !== null, 'tokens should still be returned');
    assert(tokens2['agent-a'], 'agent-a should still have a token');
  } finally {
    await env.cleanup();
  }
});

// ── Test: multiple agents register in one call ──────────────────────────────

t.test('multiple agents register in single call', async () => {
  const env = await createTempOpenClaw({ agents: ['bot-1', 'bot-2', 'bot-3'] });
  try {
    const { autoRegisterAgents } = await import('../src/register.js');
    const tokens = await autoRegisterAgents(
      'http://localhost:18900',
      'multi@example.com',
      env.tokensFilePath,
      console,
    );

    assert(tokens !== null, 'tokens should not be null');
    assertEqual(Object.keys(tokens).length, 3, 'should have 3 tokens');
    assert(tokens['bot-1'], 'bot-1 should have token');
    assert(tokens['bot-2'], 'bot-2 should have token');
    assert(tokens['bot-3'], 'bot-3 should have token');
  } finally {
    await env.cleanup();
  }
});

// ── Test: 409 conflict recovers token ────────────────────────────────────────

t.test('409 conflict recovers existing api_key', async () => {
  const env = await createTempOpenClaw({ agents: ['agent-conflict'] });
  try {
    const { autoRegisterAgents } = await import('../src/register.js');

    // First registration
    const tokens1 = await autoRegisterAgents(
      'http://localhost:18900',
      'conflict@example.com',
      env.tokensFilePath,
      console,
    );
    const originalKey = tokens1['agent-conflict'];

    // Delete local tokens file to simulate loss
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(env.tokensFilePath, '{}');

    // Re-register — should get 409 and recover same key
    const tokens2 = await autoRegisterAgents(
      'http://localhost:18900',
      'conflict@example.com',
      env.tokensFilePath,
      console,
    );

    assertEqual(tokens2['agent-conflict'], originalKey, 'should recover same api_key on 409');
  } finally {
    await env.cleanup();
  }
});

// ── Test: lazy machineId — not fetched when all agents cached ────────────────

t.test('lazy machineId: no fetch when all agents already have tokens', async () => {
  const env = await createTempOpenClaw({ agents: ['cached-agent'] });
  try {
    const { autoRegisterAgents } = await import('../src/register.js');

    // First: register normally
    await autoRegisterAgents('http://localhost:18900', 'lazy@example.com', env.tokensFilePath, console);

    // Now remove device.json to prove machineId is NOT fetched
    const { rm: rmFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await rmFile(join(env.openclawDir, 'identity', 'device.json'));

    // Second call — all agents cached, should succeed without machineId
    const tokens = await autoRegisterAgents('http://localhost:18900', 'lazy@example.com', env.tokensFilePath, console);
    assert(tokens !== null, 'should return tokens even without device.json');
    assert(tokens['cached-agent'], 'cached-agent should have token');
  } finally {
    await env.cleanup();
  }
});

// ── Test: lazy machineId — fetched only when new agent needs registration ────

t.test('lazy machineId: fetched when new unregistered agent found', async () => {
  const env = await createTempOpenClaw({ agents: ['old-agent', 'new-agent'] });
  try {
    const { autoRegisterAgents } = await import('../src/register.js');

    // Register only old-agent first
    const env1 = await createTempOpenClaw({ agents: ['old-agent'] });
    await autoRegisterAgents('http://localhost:18900', 'lazy2@example.com', env1.tokensFilePath, console);

    // Copy tokens to env (only old-agent has token)
    const { readFile: rf, writeFile: wf } = await import('node:fs/promises');
    const oldTokens = await rf(env1.tokensFilePath, 'utf8');
    await wf(env.tokensFilePath, oldTokens);
    await env1.cleanup();

    // Now register with both agents — device.json exists, new-agent triggers machineId fetch
    const tokens = await autoRegisterAgents('http://localhost:18900', 'lazy2@example.com', env.tokensFilePath, console);
    assert(tokens !== null, 'should return tokens');
    assert(tokens['old-agent'], 'old-agent should have token');
    assert(tokens['new-agent'], 'new-agent should have token');
  } finally {
    await env.cleanup();
  }
});

// ── Test: no agents directory → returns null ─────────────────────────────────

t.test('no agents directory returns null', async () => {
  const env = await createTempOpenClaw({ agents: [] });
  try {
    // Remove agents dir
    const { rm: rmDir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await rmDir(join(env.openclawDir, 'agents'), { recursive: true });

    const { autoRegisterAgents } = await import('../src/register.js');
    const tokens = await autoRegisterAgents(
      'http://localhost:18900',
      'empty@example.com',
      env.tokensFilePath,
      console,
    );

    assertEqual(tokens, null, 'should return null when no agents');
  } finally {
    await env.cleanup();
  }
});

// ── Test: registerSingleAgent ────────────────────────────────────────────────

t.test('registerSingleAgent registers new agent using cached metadata', async () => {
  const env = await createTempOpenClaw({ agents: ['existing', 'newcomer'] });
  try {
    const { autoRegisterAgents, registerSingleAgent } = await import('../src/register.js');

    // First: register existing agent to populate metadata in .tokens.json
    const env1 = await createTempOpenClaw({ agents: ['existing'] });
    await autoRegisterAgents('http://localhost:18900', 'single@example.com', env1.tokensFilePath, console);
    const { readFile: rf, writeFile: wf } = await import('node:fs/promises');
    await wf(env.tokensFilePath, await rf(env1.tokensFilePath, 'utf8'));
    await env1.cleanup();

    // Register newcomer via registerSingleAgent
    const result = await registerSingleAgent('newcomer', env.tokensFilePath, console);
    assert(result !== null, 'should return registration result');
    assert(result.api_key, 'should have api_key');
    assert(result.kk_agent_id, 'should have kk_agent_id');
  } finally {
    await env.cleanup();
  }
});

// ── Run ──────────────────────────────────────────────────────────────────────

await mockServer.start();
const ok = await t.run();
await mockServer.stop();
process.exit(ok ? 0 : 1);
