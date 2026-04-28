/**
 * Tests for runtime tools.alsoAllow patch.
 * 运行时 tools.alsoAllow patch 测试。
 *
 * Covers the v3.0.3 first-time setup that auto-adds `kinthai_*` to
 * `config.tools.alsoAllow` so plugin tools survive strict tool profiles
 * (e.g. `tools.profile: "messaging"`).
 */

import { TestRunner, assert, assertEqual } from './helpers.js';
import {
  computeAlsoAllowPatch,
  applyAlsoAllowPatch,
  checkEmailConfigured,
  KINTHAI_TOOL_PATTERN,
} from '../src/config-patch.js';

const t = new TestRunner('Config Patch Tests (tools.alsoAllow)');

function makeLog() {
  const records = [];
  return {
    records,
    info: (...args) => records.push({ level: 'info', args }),
    warn: (...args) => records.push({ level: 'warn', args }),
    debug: (...args) => records.push({ level: 'debug', args }),
    error: (...args) => records.push({ level: 'error', args }),
  };
}

// ── computeAlsoAllowPatch (pure) ─────────────────────────────────────────────

t.test('computeAlsoAllowPatch — first-time append preserves existing entries and order', () => {
  const cfg = { tools: { alsoAllow: ['memory_search'] } };
  const next = computeAlsoAllowPatch(cfg);
  assert(next, 'returns a patched config');
  assertEqual(JSON.stringify(next.tools.alsoAllow), JSON.stringify(['memory_search', 'kinthai_*']),
    'kinthai_* appended after existing entries');
});

t.test('computeAlsoAllowPatch — idempotent when pattern already present', () => {
  const cfg = { tools: { alsoAllow: ['kinthai_*', 'memory_search'] } };
  const next = computeAlsoAllowPatch(cfg);
  assertEqual(next, null, 'returns null when already present');
});

t.test('computeAlsoAllowPatch — tools section absent', () => {
  const cfg = { gateway: { port: 18789 } };
  const next = computeAlsoAllowPatch(cfg);
  assert(next, 'creates tools section');
  assertEqual(JSON.stringify(next.tools.alsoAllow), JSON.stringify(['kinthai_*']),
    'alsoAllow created with kinthai_* only');
  assertEqual(next.gateway.port, 18789, 'unrelated fields preserved');
});

t.test('computeAlsoAllowPatch — tools.alsoAllow undefined', () => {
  const cfg = { tools: { profile: 'messaging' } };
  const next = computeAlsoAllowPatch(cfg);
  assert(next, 'returns a patched config');
  assertEqual(JSON.stringify(next.tools.alsoAllow), JSON.stringify(['kinthai_*']));
  assertEqual(next.tools.profile, 'messaging', 'profile preserved');
});

t.test('computeAlsoAllowPatch — multi-entry alsoAllow preserves order', () => {
  const cfg = { tools: { alsoAllow: ['foo', 'bar'] } };
  const next = computeAlsoAllowPatch(cfg);
  assertEqual(JSON.stringify(next.tools.alsoAllow), JSON.stringify(['foo', 'bar', 'kinthai_*']));
});

t.test('computeAlsoAllowPatch — does not mutate input', () => {
  const cfg = { tools: { alsoAllow: ['memory_search'] } };
  const before = JSON.stringify(cfg);
  computeAlsoAllowPatch(cfg);
  assertEqual(JSON.stringify(cfg), before, 'input config unchanged after patch');
});

t.test('computeAlsoAllowPatch — null/undefined config tolerated', () => {
  const next = computeAlsoAllowPatch(null);
  assert(next, 'null config returns a config');
  assertEqual(JSON.stringify(next.tools.alsoAllow), JSON.stringify(['kinthai_*']));
});

t.test('KINTHAI_TOOL_PATTERN constant', () => {
  assertEqual(KINTHAI_TOOL_PATTERN, 'kinthai_*');
});

// ── applyAlsoAllowPatch (integration with writeConfigFile) ───────────────────

t.test('applyAlsoAllowPatch — first-time write happens, info logged', async () => {
  const writes = [];
  const writeFn = async (cfg) => { writes.push(cfg); };
  const log = makeLog();
  const api = { config: { tools: { alsoAllow: ['memory_search'] } } };

  const wrote = await applyAlsoAllowPatch(api, log, writeFn);

  assertEqual(wrote, true, 'reports write happened');
  assertEqual(writes.length, 1, 'writeFn called once');
  assertEqual(JSON.stringify(writes[0].tools.alsoAllow),
    JSON.stringify(['memory_search', 'kinthai_*']));
  const infos = log.records.filter(r => r.level === 'info');
  assertEqual(infos.length, 1, 'one info log');
  assert(infos[0].args[0].includes('KK-I031'), 'log carries KK-I031 code');
  assert(infos[0].args[0].includes('kinthai_*'), 'log mentions pattern');
});

t.test('applyAlsoAllowPatch — idempotent restart skips write, no log', async () => {
  const writes = [];
  const writeFn = async (cfg) => { writes.push(cfg); };
  const log = makeLog();
  const api = { config: { tools: { alsoAllow: ['kinthai_*'] } } };

  const wrote = await applyAlsoAllowPatch(api, log, writeFn);

  assertEqual(wrote, false, 'reports no write');
  assertEqual(writes.length, 0, 'writeFn not called');
  assertEqual(log.records.length, 0, 'no log lines');
});

t.test('applyAlsoAllowPatch — empty tools section creates it', async () => {
  const writes = [];
  const writeFn = async (cfg) => { writes.push(cfg); };
  const log = makeLog();
  const api = { config: {} };

  const wrote = await applyAlsoAllowPatch(api, log, writeFn);

  assertEqual(wrote, true);
  assertEqual(writes.length, 1);
  assertEqual(JSON.stringify(writes[0].tools.alsoAllow), JSON.stringify(['kinthai_*']));
});

t.test('applyAlsoAllowPatch — writeFn rejection logs warn, does not throw', async () => {
  const writeFn = async () => { throw new Error('EACCES: permission denied'); };
  const log = makeLog();
  const api = { config: { tools: { alsoAllow: ['memory_search'] } } };

  // Must not throw — the patch is best-effort
  const wrote = await applyAlsoAllowPatch(api, log, writeFn);

  assertEqual(wrote, false, 'reports no successful write');
  const warns = log.records.filter(r => r.level === 'warn');
  assertEqual(warns.length, 1, 'one warn log');
  assert(warns[0].args[0].includes('KK-W009'), 'warn carries KK-W009 code');
  assert(warns[0].args[0].includes('EACCES'), 'warn includes underlying error message');
});

t.test('applyAlsoAllowPatch — preserves customer extras', async () => {
  const writes = [];
  const writeFn = async (cfg) => { writes.push(cfg); };
  const log = makeLog();
  const api = { config: { tools: { alsoAllow: ['foo', 'bar'] } } };

  await applyAlsoAllowPatch(api, log, writeFn);

  assertEqual(JSON.stringify(writes[0].tools.alsoAllow),
    JSON.stringify(['foo', 'bar', 'kinthai_*']),
    'customer entries kept in original order, kinthai_* appended');
});

t.test('applyAlsoAllowPatch — falls back to api.runtime.config.writeConfigFile when no writeFn passed', async () => {
  // Production path — SDK injects writeConfigFile onto api.runtime.config.
  // Tests this path explicitly because v3.0.4 used a broken ESM dynamic
  // import that silently failed in production.
  const writes = [];
  const log = makeLog();
  const api = {
    config: { tools: { alsoAllow: ['memory_search'] } },
    runtime: {
      config: {
        writeConfigFile: async (cfg) => { writes.push(cfg); },
      },
    },
  };

  const wrote = await applyAlsoAllowPatch(api, log);

  assertEqual(wrote, true, 'reports successful write');
  assertEqual(writes.length, 1, 'runtime.config.writeConfigFile invoked');
  assertEqual(JSON.stringify(writes[0].tools.alsoAllow),
    JSON.stringify(['memory_search', 'kinthai_*']));
  const infos = log.records.filter(r => r.level === 'info');
  assertEqual(infos.length, 1);
  assert(infos[0].args[0].includes('KK-I031'));
});

t.test('applyAlsoAllowPatch — runtime missing logs KK-W009 with explicit reason', async () => {
  const log = makeLog();
  const api = { config: { tools: { alsoAllow: ['memory_search'] } } }; // no runtime

  const wrote = await applyAlsoAllowPatch(api, log);

  assertEqual(wrote, false);
  const warns = log.records.filter(r => r.level === 'warn');
  assertEqual(warns.length, 1);
  assert(warns[0].args[0].includes('KK-W009'));
  assert(warns[0].args[0].includes('writeConfigFile'),
    'warn message names the missing API so ops can grep for it');
});

// ── checkEmailConfigured (KK-E001 surface for missing email) ─────────────────

t.test('checkEmailConfigured — valid email, no log, returns true', () => {
  const log = makeLog();
  const api = { config: { channels: { kinthai: { email: 'alice@example.com' } } } };
  const ok = checkEmailConfigured(api, log);
  assertEqual(ok, true);
  assertEqual(log.records.length, 0, 'no log lines emitted');
});

t.test('checkEmailConfigured — email undefined logs KK-E001 error', () => {
  const log = makeLog();
  const api = { config: { channels: { kinthai: {} } } };
  const ok = checkEmailConfigured(api, log);
  assertEqual(ok, false);
  const errors = log.records.filter(r => r.level === 'error');
  assertEqual(errors.length, 1, 'one error log');
  assert(errors[0].args[0].includes('KK-E001'), 'log carries KK-E001 code');
  assert(errors[0].args[0].includes('channels.kinthai.email is not set'),
    'log mentions the config path');
});

t.test('checkEmailConfigured — empty string email logs KK-E001', () => {
  const log = makeLog();
  const api = { config: { channels: { kinthai: { email: '' } } } };
  const ok = checkEmailConfigured(api, log);
  assertEqual(ok, false);
  assertEqual(log.records.filter(r => r.level === 'error').length, 1);
});

t.test('checkEmailConfigured — whitespace-only email logs KK-E001', () => {
  const log = makeLog();
  const api = { config: { channels: { kinthai: { email: '   ' } } } };
  const ok = checkEmailConfigured(api, log);
  assertEqual(ok, false);
  assertEqual(log.records.filter(r => r.level === 'error').length, 1);
});

t.test('checkEmailConfigured — channels.kinthai missing logs KK-E001', () => {
  const log = makeLog();
  const api = { config: { channels: {} } };
  const ok = checkEmailConfigured(api, log);
  assertEqual(ok, false);
  assertEqual(log.records.filter(r => r.level === 'error').length, 1);
});

t.test('checkEmailConfigured — non-string email (e.g. {} from corrupt config) logs KK-E001', () => {
  const log = makeLog();
  const api = { config: { channels: { kinthai: { email: {} } } } };
  const ok = checkEmailConfigured(api, log);
  assertEqual(ok, false, 'non-string email rejected');
  assertEqual(log.records.filter(r => r.level === 'error').length, 1);
});

t.test('checkEmailConfigured — fix-it hint mentions both config commands', () => {
  const log = makeLog();
  const api = { config: {} };
  checkEmailConfigured(api, log);
  const msg = log.records[0].args[0];
  assert(msg.includes('openclaw config set'), 'mentions config set command');
  assert(msg.includes('openclaw setup --wizard'), 'mentions wizard fallback');
});

// ── Run ──────────────────────────────────────────────────────────────────────

const ok = await t.run();
process.exit(ok ? 0 : 1);
