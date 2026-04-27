/**
 * Tests for src/tools/continuation.js
 *
 * Uses a fake `api` (continueTool stub) — no mock server needed.
 * Covers: terminal pass-through, single continuation, depth limit (10),
 * unknown type, local primitive failures, and continueTool throw.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRunner, assert, assertEqual } from './helpers.js';
import {
  runContinuationLoop,
  MAX_CONTINUATION_DEPTH,
} from '../src/tools/continuation.js';
import { buildAllowlist } from '../src/tools/local-primitives.js';

const t = new TestRunner('Continuation Tests');

let workspace;
const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

async function setup() {
  workspace = await mkdtemp(join(tmpdir(), 'oc-cont-'));
  await writeFile(join(workspace, 'hi.txt'), 'hello');
}

async function teardown() {
  await rm(workspace, { recursive: true, force: true });
}

function makeApi(continueImpl) {
  return {
    continueTool: continueImpl,
    uploadFile: async () => ({ file_id: 'file-mock' }),
  };
}

t.test('terminal response passes through unchanged', async () => {
  const api = makeApi(async () => { throw new Error('should not be called'); });
  const r = await runContinuationLoop(api, { ok: true, data: { x: 1 } }, {
    allowedPrefixes: buildAllowlist({ workspaceDir: workspace }),
    log,
  });
  assertEqual(r.ok, true, 'terminal ok');
  assertEqual(r.data.x, 1, 'terminal data preserved');
});

t.test('single read_local_file continuation walks through', async () => {
  let receivedResult = null;
  const api = makeApi(async (id, result) => {
    receivedResult = result;
    return { ok: true, data: { ack: id } };
  });
  const r = await runContinuationLoop(api, {
    continuation: { id: 'k_abc', type: 'read_local_file', path: join(workspace, 'hi.txt') },
  }, {
    allowedPrefixes: buildAllowlist({ workspaceDir: workspace }),
    log,
  });
  assertEqual(r.ok, true, 'terminal after continuation');
  assertEqual(r.data.ack, 'k_abc', 'continuation_id forwarded');
  assert(receivedResult.content_b64, 'plugin reported content_b64');
  const decoded = Buffer.from(receivedResult.content_b64, 'base64').toString('utf8');
  assertEqual(decoded, 'hello', 'file content read correctly');
});

t.test('chained continuations walk to terminal', async () => {
  let step = 0;
  const api = makeApi(async () => {
    step++;
    if (step < 3) {
      return { continuation: { id: `k_step_${step}`, type: 'list_local_dir', path: workspace } };
    }
    return { ok: true, data: { steps: step } };
  });
  const r = await runContinuationLoop(api, {
    continuation: { id: 'k_step_0', type: 'list_local_dir', path: workspace },
  }, {
    allowedPrefixes: buildAllowlist({ workspaceDir: workspace }),
    log,
  });
  assertEqual(r.ok, true, 'terminated');
  assertEqual(r.data.steps, 3, 'walked 3 steps');
});

t.test('depth limit triggers continuation_loop_too_deep', async () => {
  const api = makeApi(async () =>
    ({ continuation: { id: 'k_loop', type: 'list_local_dir', path: workspace } }),
  );
  const r = await runContinuationLoop(api, {
    continuation: { id: 'k_loop_0', type: 'list_local_dir', path: workspace },
  }, {
    allowedPrefixes: buildAllowlist({ workspaceDir: workspace }),
    log,
  });
  assertEqual(r.ok, false, 'should fail');
  assertEqual(r.error, 'continuation_loop_too_deep', 'specific error code');
});

t.test('unknown continuation type sends error back to backend', async () => {
  let backendSeen = null;
  const api = makeApi(async (id, result) => {
    backendSeen = result;
    return { ok: false, error: 'unknown_continuation_type', hint: 'plugin reported it' };
  });
  const r = await runContinuationLoop(api, {
    continuation: { id: 'k_x', type: 'mystery_op', path: '/tmp/foo' },
  }, {
    allowedPrefixes: buildAllowlist(),
    log,
  });
  assertEqual(backendSeen.ok, false, 'plugin reported failure to backend');
  assertEqual(backendSeen.error, 'unknown_continuation_type', 'error code');
  assertEqual(r.ok, false, 'final terminal failure');
});

t.test('path_denied continuation reported to backend', async () => {
  let backendSeen = null;
  const api = makeApi(async (id, result) => {
    backendSeen = result;
    return { ok: false, error: 'path_denied', hint: 'forwarded' };
  });
  await runContinuationLoop(api, {
    continuation: { id: 'k_y', type: 'read_local_file', path: '/etc/passwd' },
  }, {
    allowedPrefixes: buildAllowlist({ workspaceDir: workspace }),
    log,
  });
  assertEqual(backendSeen.ok, false, 'plugin reported failure');
  assertEqual(backendSeen.error, 'path_denied', 'path_denied propagated');
});

t.test('continueTool throw maps to backend_unavailable', async () => {
  const api = makeApi(async () => { throw new Error('network blip'); });
  const r = await runContinuationLoop(api, {
    continuation: { id: 'k_z', type: 'read_local_file', path: join(workspace, 'hi.txt') },
  }, {
    allowedPrefixes: buildAllowlist({ workspaceDir: workspace }),
    log,
  });
  assertEqual(r.ok, false, 'should fail');
  assertEqual(r.error, 'backend_unavailable', 'backend_unavailable code');
});

t.test('MAX_CONTINUATION_DEPTH constant is 10', () => {
  assertEqual(MAX_CONTINUATION_DEPTH, 10, 'depth cap is 10');
});

// ── Run ──────────────────────────────────────────────────────────────────────

await setup();
const ok = await t.run();
await teardown();
process.exit(ok ? 0 : 1);
