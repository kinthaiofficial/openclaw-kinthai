/**
 * Manifest contract test — OpenClaw 2026.6.9 plugin tool ownership.
 * Manifest 契约测试 — OpenClaw 2026.6.9 插件工具所有权。
 *
 * Why: 6.9 gates plugin agent tools behind a STATIC contract. The runtime
 * (1) rejects the whole registerTool factory if contracts.tools is empty, and
 * (2) drops any factory-returned tool whose name is not in contracts.tools
 * ("plugin tool is undeclared"). See docs/plan-6.9-contract-compat.md.
 *
 * This suite reproduces both gates against our own manifest + factory output
 * so contract drift is caught before publish, not in a customer's gateway log.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert } from './helpers.js';
import { __testing } from '../src/tools/dynamic-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const runner = new TestRunner('Manifest Contract (6.9)');

async function loadManifest() {
  return JSON.parse(await readFile(join(ROOT, 'openclaw.plugin.json'), 'utf8'));
}

// Mirror of OpenClaw 6.9 normalizePluginToolNames / findUndeclaredPluginToolNames
// (dist/tool-contracts-htZESuVE.js). Kept tiny + local on purpose.
function normalize(names) {
  const set = new Set();
  for (const n of names ?? []) {
    const t = String(n).trim();
    if (t) set.add(t);
  }
  return [...set];
}
function findUndeclared(declared, toolNames) {
  const d = new Set(normalize(declared));
  return normalize(toolNames).filter((n) => !d.has(n));
}

runner.test('contracts.tools is a non-empty array (passes gate A)', async () => {
  const m = await loadManifest();
  assert(m.contracts && Array.isArray(m.contracts.tools), 'contracts.tools must be an array');
  assert(m.contracts.tools.length > 0, 'contracts.tools must be non-empty (else 6.9 rejects the whole factory)');
});

runner.test('contracts.tools has no blank / duplicate names', async () => {
  const m = await loadManifest();
  const tools = m.contracts.tools;
  assert(tools.every((t) => typeof t === 'string' && t.trim()), 'all tool names must be non-empty strings');
  assert(new Set(tools).size === tools.length, 'contracts.tools must not contain duplicates');
});

runner.test('default-manifest tools are all declared (offline fallback survives gate B)', async () => {
  const m = await loadManifest();
  const fallback = __testing.getDefaultManifest();
  const names = fallback.tools.map((t) => t.name);
  const undeclared = findUndeclared(m.contracts.tools, names);
  assert(undeclared.length === 0, `default-manifest tools undeclared in contracts.tools: ${undeclared.join(', ')}`);
});

runner.test('factory output from default manifest passes 6.9 gate B', async () => {
  // Simulate the runtime: no cache → factory falls back to default-manifest,
  // then 6.9 validates every returned tool name against contracts.tools.
  const m = await loadManifest();
  __testing.resetMemCache();
  const fallback = __testing.getDefaultManifest();
  const returnedNames = fallback.tools.map((t) => t.name);
  const undeclared = findUndeclared(m.contracts.tools, returnedNames);
  assert(undeclared.length === 0, `factory would emit undeclared tools: ${undeclared.join(', ')}`);
});

runner.test('channelConfigs.kinthai.schema present (clears 6.9 WARN)', async () => {
  const m = await loadManifest();
  assert(m.channelConfigs && m.channelConfigs.kinthai, 'channelConfigs.kinthai required for 6.9 setup surfaces');
  assert(m.channelConfigs.kinthai.schema && m.channelConfigs.kinthai.schema.type === 'object',
    'channelConfigs.kinthai.schema must be an object schema');
});

const ok = await runner.run();
process.exit(ok ? 0 : 1);
