/**
 * Edge case tests for agent registration.
 * 注册流程的边界/异常测试。
 */

import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as mockServer from './mock-server.js';
import { createTempOpenClaw, TestRunner, assert, assertEqual } from './helpers.js';

const t = new TestRunner('Registration Edge Cases');

// ── 403: machine owner mismatch ──────────────────────────────────────────────

t.test('403 owner mismatch: same machine, different email', async () => {
  const env = await createTempOpenClaw({ agents: ['agent-x'] });
  try {
    const { autoRegisterAgents } = await import('../src/register.js');

    // First registration with email-A
    await autoRegisterAgents('http://localhost:18900', 'ownerA@example.com', env.tokensFilePath, console);

    // New env, same deviceId but different email
    const env2 = await createTempOpenClaw({ agents: ['agent-y'], deviceId: env.deviceId });
    try {
      const tokens2 = await autoRegisterAgents('http://localhost:18900', 'ownerB@example.com', env2.tokensFilePath, console);
      // agent-y should NOT have a token (403)
      if (tokens2) {
        assert(!tokens2['agent-y'], 'agent-y should not get token on 403');
      }
    } finally {
      await env2.cleanup();
    }
  } finally {
    await env.cleanup();
  }
});

// ── Server unreachable ───────────────────────────────────────────────────────

t.test('server unreachable: returns null gracefully', async () => {
  const env = await createTempOpenClaw({ agents: ['offline-agent'] });
  try {
    const { autoRegisterAgents } = await import('../src/register.js');
    // Point to a port nothing listens on
    const tokens = await autoRegisterAgents(
      'http://localhost:19999',
      'test@example.com',
      env.tokensFilePath,
      console,
    );
    // Should not crash, should return null or tokens without the new agent
    // (existing cached agents would still return)
    assertEqual(tokens, null, 'should return null when server unreachable');
  } finally {
    await env.cleanup();
  }
});

// ── No device.json and no gateway → machineId unavailable ────────────────────

t.test('no device.json + no gateway: machineId unavailable, registration skipped', async () => {
  const env = await createTempOpenClaw({ agents: ['no-id-agent'] });
  try {
    // Remove device.json
    await rm(join(env.openclawDir, 'identity', 'device.json'));

    const { autoRegisterAgents } = await import('../src/register.js');
    const tokens = await autoRegisterAgents(
      'http://localhost:18900',
      'test@example.com',
      env.tokensFilePath,
      console,
    );
    // getMachineId will fail (no file, gateway RPC will timeout/fail)
    // Should return null — no agents registered
    assertEqual(tokens, null, 'should return null when machineId unavailable');
  } finally {
    await env.cleanup();
  }
});

// ── Mixed: some agents cached, some new, machineId unavailable ───────────────

t.test('mixed: cached agents returned even when machineId unavailable for new ones', async () => {
  const env = await createTempOpenClaw({ agents: ['cached', 'uncached'] });
  try {
    const { autoRegisterAgents } = await import('../src/register.js');

    // First: register only 'cached'
    const env1 = await createTempOpenClaw({ agents: ['cached'] });
    await autoRegisterAgents('http://localhost:18900', 'mix@example.com', env1.tokensFilePath, console);
    // Copy tokens
    await writeFile(env.tokensFilePath, await readFile(env1.tokensFilePath, 'utf8'));
    await env1.cleanup();

    // Remove device.json so machineId is unavailable for new agent
    await rm(join(env.openclawDir, 'identity', 'device.json'));

    // Call with both agents — 'cached' has token, 'uncached' needs registration but no machineId
    const tokens = await autoRegisterAgents('http://localhost:18900', 'mix@example.com', env.tokensFilePath, console);
    assert(tokens !== null, 'should still return tokens for cached agents');
    assert(tokens['cached'], 'cached agent should have token');
    assert(!tokens['uncached'], 'uncached agent should NOT have token (no machineId)');
  } finally {
    await env.cleanup();
  }
});

// ── Empty email → autoRegisterAgents not called (plugin.js logic) ────────────

t.test('empty email: scanLocalState still works, just no registration', async () => {
  const env = await createTempOpenClaw({ agents: ['agent-noemail'] });
  try {
    const { scanLocalState } = await import('../src/register-scan.js');
    const state = await scanLocalState(env.tokensFilePath, console);

    assert(state !== null, 'scanLocalState should succeed without email');
    assert(state.openclawDir, 'should have openclawDir');
    assert(state.agentIds.includes('agent-noemail'), 'should find agent');
    assertEqual(Object.keys(state.tokensData).length, 0, 'tokensData should be empty');
  } finally {
    await env.cleanup();
  }
});

// ── Corrupted .tokens.json ───────────────────────────────────────────────────

t.test('corrupted .tokens.json: treated as empty, re-registers', async () => {
  const env = await createTempOpenClaw({ agents: ['corrupt-agent'] });
  try {
    // Write garbage to tokens file
    await writeFile(env.tokensFilePath, '{{{not json!!!');

    const { autoRegisterAgents } = await import('../src/register.js');
    const tokens = await autoRegisterAgents(
      'http://localhost:18900',
      'corrupt@example.com',
      env.tokensFilePath,
      console,
    );

    assert(tokens !== null, 'should recover from corrupted tokens');
    assert(tokens['corrupt-agent'], 'should register agent fresh');
  } finally {
    await env.cleanup();
  }
});

// ── .tokens.json with stale agent (agent dir removed) ────────────────────────

t.test('stale token: agent removed from disk but token remains in file', async () => {
  const env = await createTempOpenClaw({ agents: ['alive', 'ghost'] });
  try {
    const { autoRegisterAgents } = await import('../src/register.js');

    // Register both
    await autoRegisterAgents('http://localhost:18900', 'stale@example.com', env.tokensFilePath, console);

    // Remove 'ghost' agent directory
    await rm(join(env.openclawDir, 'agents', 'ghost'), { recursive: true });

    // Re-scan — ghost is no longer in agentIds but still in .tokens.json
    const tokens = await autoRegisterAgents('http://localhost:18900', 'stale@example.com', env.tokensFilePath, console);
    assert(tokens !== null, 'should return tokens');
    assert(tokens['alive'], 'alive agent should still work');
    // ghost token is in .tokens.json but not in agentIds — it appears in the return
    // because we iterate over tokensData for the return value, not just agentIds
    // This is actually fine — the token is still valid
  } finally {
    await env.cleanup();
  }
});

// ── registerSingleAgent: missing email returns null ──────────────────────────

t.test('registerSingleAgent: fails gracefully when email is missing', async () => {
  const env = await createTempOpenClaw({ agents: ['orphan'] });
  try {
    const { registerSingleAgent } = await import('../src/register.js');
    // No email passed
    const result = await registerSingleAgent('orphan', 'http://localhost:18900', null, env.tokensFilePath, console);
    assertEqual(result, null, 'should return null — no email');
  } finally {
    await env.cleanup();
  }
});

// ── registerSingleAgent: already registered returns null ─────────────────────

t.test('registerSingleAgent: returns null for already registered agent', async () => {
  const env = await createTempOpenClaw({ agents: ['existing'] });
  try {
    const { autoRegisterAgents, registerSingleAgent } = await import('../src/register.js');
    await autoRegisterAgents('http://localhost:18900', 'dup@example.com', env.tokensFilePath, console);

    const result = await registerSingleAgent(
      'existing',
      'http://localhost:18900',
      'dup@example.com',
      env.tokensFilePath,
      console,
    );
    assertEqual(result, null, 'should return null — already registered');
  } finally {
    await env.cleanup();
  }
});

// ── Large number of agents ───────────────────────────────────────────────────

t.test('bulk registration: 20 agents at once', async () => {
  const agents = Array.from({ length: 20 }, (_, i) => `bulk-${String(i).padStart(2, '0')}`);
  const env = await createTempOpenClaw({ agents });
  try {
    const { autoRegisterAgents } = await import('../src/register.js');
    const tokens = await autoRegisterAgents(
      'http://localhost:18900',
      'bulk@example.com',
      env.tokensFilePath,
      console,
    );

    assert(tokens !== null, 'should return tokens');
    assertEqual(Object.keys(tokens).length, 20, 'should have 20 tokens');
    for (const name of agents) {
      assert(tokens[name], `${name} should have token`);
    }
  } finally {
    await env.cleanup();
  }
});

// ── Run ──────────────────────────────────────────────────────────────────────

await mockServer.start();
const ok = await t.run();
await mockServer.stop();
process.exit(ok ? 0 : 1);
