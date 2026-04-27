/**
 * Tests for src/tools/local-primitives.js
 *
 * Covers: path allowlist enforcement (P0-#13 multi-agent isolation),
 * file size limits, missing files, base64 round-trip, dir listing.
 *
 * No mock server needed — pure local filesystem.
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TestRunner, assert, assertEqual } from './helpers.js';
import {
  buildAllowlist,
  readLocalFile,
  writeLocalFile,
  listLocalDir,
  MAX_INLINE_FILE_BYTES,
} from '../src/tools/local-primitives.js';

const t = new TestRunner('Local Primitives Tests');

// IMPORTANT: workspaces must live OUTSIDE /tmp because /tmp is in the default
// allowlist (legitimately — agents are allowed to use /tmp). To test path
// boundary semantics, we create test dirs under /var/tmp which is NOT in the
// default allowlist.
const TEST_ROOT = '/var/tmp';

let agentAWorkspace;
let agentBWorkspace;
let outsideDir;

async function setup() {
  agentAWorkspace = await mkdtemp(join(TEST_ROOT, 'oc-prim-A-'));
  agentBWorkspace = await mkdtemp(join(TEST_ROOT, 'oc-prim-B-'));
  outsideDir      = await mkdtemp(join(TEST_ROOT, 'oc-prim-out-'));

  await writeFile(join(agentAWorkspace, 'a.txt'), 'agent A secret');
  await writeFile(join(agentBWorkspace, 'b.txt'), 'agent B secret');
  await writeFile(join(outsideDir, 'outside.txt'), 'not in any allowlist');
}

async function teardown() {
  await rm(agentAWorkspace, { recursive: true, force: true });
  await rm(agentBWorkspace, { recursive: true, force: true });
  await rm(outsideDir,      { recursive: true, force: true });
}

t.test('buildAllowlist includes /tmp + workspaceDir', () => {
  const list = buildAllowlist({ workspaceDir: '/home/agent/workspace' });
  assert(list.includes('/tmp'), 'should include /tmp');
  assert(list.includes('/home/agent/workspace'), 'should include workspaceDir');
});

t.test('buildAllowlist with no workspaceDir still has /tmp', () => {
  const list = buildAllowlist();
  assert(list.includes('/tmp'), 'should include /tmp without workspaceDir');
});

t.test('readLocalFile reads file inside workspace allowlist', async () => {
  const allowlist = buildAllowlist({ workspaceDir: agentAWorkspace });
  const r = await readLocalFile(join(agentAWorkspace, 'a.txt'), allowlist);
  const decoded = Buffer.from(r.content_b64, 'base64').toString('utf8');
  assertEqual(decoded, 'agent A secret', 'content matches');
});

t.test('readLocalFile path_denied for /etc/passwd', async () => {
  const allowlist = buildAllowlist({ workspaceDir: agentAWorkspace });
  let code = null;
  try { await readLocalFile('/etc/passwd', allowlist); }
  catch (err) { code = err.code; }
  assertEqual(code, 'path_denied', 'should deny /etc/passwd');
});

t.test('readLocalFile path_denied for outside workspace', async () => {
  const allowlist = buildAllowlist({ workspaceDir: agentAWorkspace });
  let code = null;
  try { await readLocalFile(join(outsideDir, 'outside.txt'), allowlist); }
  catch (err) { code = err.code; }
  assertEqual(code, 'path_denied', 'should deny outside dir');
});

t.test('readLocalFile path_not_found for missing file', async () => {
  const allowlist = buildAllowlist({ workspaceDir: agentAWorkspace });
  let code = null;
  try { await readLocalFile(join(agentAWorkspace, 'nope.txt'), allowlist); }
  catch (err) { code = err.code; }
  assertEqual(code, 'path_not_found', 'should be path_not_found');
});

t.test('readLocalFile path_too_large for > 8MB file', async () => {
  const big = join(agentAWorkspace, 'big.bin');
  await writeFile(big, Buffer.alloc(MAX_INLINE_FILE_BYTES + 1));
  const allowlist = buildAllowlist({ workspaceDir: agentAWorkspace });
  let code = null;
  try { await readLocalFile(big, allowlist); }
  catch (err) { code = err.code; }
  assertEqual(code, 'path_too_large', 'should be path_too_large');
});

t.test('writeLocalFile writes and reads back', async () => {
  const allowlist = buildAllowlist({ workspaceDir: agentAWorkspace });
  const target = join(agentAWorkspace, 'sub', 'wrote.bin');
  const payload = Buffer.from([1, 2, 3, 4]).toString('base64');
  await writeLocalFile(target, payload, allowlist);
  const back = await readFile(target);
  assert(back.equals(Buffer.from([1, 2, 3, 4])), 'bytes match');
});

t.test('writeLocalFile path_denied outside allowlist', async () => {
  const allowlist = buildAllowlist({ workspaceDir: agentAWorkspace });
  let code = null;
  try {
    await writeLocalFile(join(outsideDir, 'pwn.txt'), 'aGFjaw==', allowlist);
  } catch (err) { code = err.code; }
  assertEqual(code, 'path_denied', 'should deny');
});

t.test('listLocalDir returns entries with kind/size', async () => {
  await mkdir(join(agentAWorkspace, 'sub2'), { recursive: true });
  await writeFile(join(agentAWorkspace, 'leaf.txt'), 'hi');
  const allowlist = buildAllowlist({ workspaceDir: agentAWorkspace });
  const r = await listLocalDir(agentAWorkspace, allowlist);
  assert(Array.isArray(r.entries), 'entries is array');
  const leaf = r.entries.find((e) => e.name === 'leaf.txt');
  assert(leaf, 'has leaf.txt');
  assertEqual(leaf.kind, 'file', 'leaf is file');
  assertEqual(leaf.size, 2, 'leaf size 2');
  const sub = r.entries.find((e) => e.name === 'sub2');
  assert(sub, 'has sub2');
  assertEqual(sub.kind, 'dir', 'sub2 is dir');
});

t.test('multi-agent allowlist isolation (P0-#13 regression)', async () => {
  // Simulate two concurrent agent runs in the same process.
  const allowlistA = buildAllowlist({ workspaceDir: agentAWorkspace });
  const allowlistB = buildAllowlist({ workspaceDir: agentBWorkspace });

  // Each list should NOT contain the other's workspace.
  assert(!allowlistA.some((p) => p === agentBWorkspace), 'A leaked B workspace');
  assert(!allowlistB.some((p) => p === agentAWorkspace), 'B leaked A workspace');

  // Agent A reading B's file using A's allowlist must be denied.
  let code = null;
  try {
    await readLocalFile(join(agentBWorkspace, 'b.txt'), allowlistA);
  } catch (err) { code = err.code; }
  assertEqual(code, 'path_denied', 'agent A read agent B workspace via stale allowlist');
});

t.test('empty allowlist denies everything', async () => {
  let code = null;
  try { await readLocalFile('/tmp/anything', []); }
  catch (err) { code = err.code; }
  assertEqual(code, 'path_denied', 'empty allowlist denies');
});

// ── Run ──────────────────────────────────────────────────────────────────────

await setup();
const ok = await t.run();
await teardown();
process.exit(ok ? 0 : 1);
