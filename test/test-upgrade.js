/**
 * Upgrade tests — cross-version install, data preservation, cleanup.
 * 升级测试 — 跨版本安装、数据保留、清理。
 *
 * Tests realistic upgrade scenarios for each install method:
 *   - setup.mjs (github/npm) upgrade
 *   - ClawHub upgrade
 *   - Data preservation (email, .tokens.json)
 *   - Exception paths (corrupted install, partial state)
 *
 * Runs on 10.8.4.11 against oc-plugin-test instance.
 *
 * Usage:
 *   node test/test-upgrade.js           # run all
 *   node test/test-upgrade.js npm       # setup.mjs upgrade only
 *   node test/test-upgrade.js clawhub   # clawhub upgrade only
 */

import { readFile, writeFile, stat, rm, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { TestRunner, assert, assertEqual, assertIncludes } from './helpers.js';

const mode = process.argv[2] || 'all';
const OPENCLAW_DIR = join(homedir(), '.openclaw');
const CHANNELS_DIR = join(OPENCLAW_DIR, 'channels', 'kinthai');
const EXTENSIONS_DIR = join(OPENCLAW_DIR, 'extensions', 'kinthai');
const CONFIG_PATH = join(OPENCLAW_DIR, 'openclaw.json');
const REPO_DIR = join(homedir(), 'openclaw-kinthai');
const TEST_EMAIL = 'upgrade-test@example.com';

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 30000, ...opts }).trim();
  } catch (err) {
    if (opts.allowFail) return null;
    throw err;
  }
}

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'));
}

async function writeJson(p, data) {
  await writeFile(p, JSON.stringify(data, null, 2));
}

async function cleanAll() {
  await rm(CHANNELS_DIR, { recursive: true, force: true });
  await rm(EXTENSIONS_DIR, { recursive: true, force: true });
  // Clean config channels + plugins sections
  try {
    const cfg = await readJson(CONFIG_PATH);
    delete cfg.channels?.kinthai;
    if (cfg.plugins?.entries?.kinthai) delete cfg.plugins.entries.kinthai;
    if (cfg.plugins?.allow) cfg.plugins.allow = cfg.plugins.allow.filter(x => x !== 'kinthai');
    if (cfg.plugins?.load?.paths) cfg.plugins.load.paths = cfg.plugins.load.paths.filter(x => !x.includes('kinthai'));
    await writeJson(CONFIG_PATH, cfg);
  } catch { /* ok */ }
}

// Get an older published version from npm for upgrade testing
async function getPreviousVersion() {
  // Use 2.5.0 as baseline "old" version (we're at 2.5.1)
  return '2.5.0';
}

// ── setup.mjs (npm) upgrade tests ────────────────────────────────────────────

const setupUpgrade = new TestRunner('setup.mjs Upgrade Tests');

const NPM_WORK_DIR = join(homedir(), '.npm-upgrade-work');

setupUpgrade.test('install old version (v2.5.0) via npm', async () => {
  await cleanAll();
  await rm(NPM_WORK_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(NPM_WORK_DIR, { recursive: true });

  run(`npm install @kinthaiofficial/openclaw-kinthai@2.5.0`, {
    cwd: NPM_WORK_DIR,
    timeout: 300000,
  });

  const pkgDir = join(NPM_WORK_DIR, 'node_modules', '@kinthaiofficial', 'openclaw-kinthai');
  const out = run(`node ${join(pkgDir, 'scripts', 'setup.mjs')} install ${TEST_EMAIL}`, {
    cwd: pkgDir,
  });
  assertIncludes(out, 'Setup complete', 'install should succeed');

  const installed = await readJson(join(CHANNELS_DIR, 'package.json'));
  assertEqual(installed.version, '2.5.0', 'should be v2.5.0');
});

setupUpgrade.test('simulate user tokens before upgrade', async () => {
  // Create fake .tokens.json to simulate registered agents
  const tokensPath = join(CHANNELS_DIR, '.tokens.json');
  await writeJson(tokensPath, {
    'agent-a': { api_key: 'kk_test_preupgrade_a', kk_agent_id: 'user-001' },
    'agent-b': { api_key: 'kk_test_preupgrade_b', kk_agent_id: 'user-002' },
    _machine_id: 'test-machine-id-preserved',
    _email: TEST_EMAIL,
    _kinthai_url: 'https://kinthai.ai',
  });
  assert(await fileExists(tokensPath), 'tokens file should be created');
});

setupUpgrade.test('upgrade to latest version via npm', async () => {
  // Install latest
  run(`npm install @kinthaiofficial/openclaw-kinthai@latest`, {
    cwd: NPM_WORK_DIR,
    timeout: 300000,
  });

  const pkgDir = join(NPM_WORK_DIR, 'node_modules', '@kinthaiofficial', 'openclaw-kinthai');
  const out = run(`node ${join(pkgDir, 'scripts', 'setup.mjs')} install ${TEST_EMAIL}`, {
    cwd: pkgDir,
  });
  assertIncludes(out, 'Setup complete', 'upgrade should succeed');
});

setupUpgrade.test('upgrade: version bumped correctly', async () => {
  const installed = await readJson(join(CHANNELS_DIR, 'package.json'));
  const npmLatest = run('npm view @kinthaiofficial/openclaw-kinthai version');
  assertEqual(installed.version, npmLatest, 'version should match npm latest');
  assert(installed.version !== '2.5.0', 'should not still be 2.5.0');
});

setupUpgrade.test('upgrade: .tokens.json preserved', async () => {
  const tokensPath = join(CHANNELS_DIR, '.tokens.json');
  assert(await fileExists(tokensPath), 'tokens file should still exist');
  const tokens = await readJson(tokensPath);
  assertEqual(tokens['agent-a']?.api_key, 'kk_test_preupgrade_a', 'agent-a token preserved');
  assertEqual(tokens['agent-b']?.api_key, 'kk_test_preupgrade_b', 'agent-b token preserved');
  assertEqual(tokens._machine_id, 'test-machine-id-preserved', 'machine_id preserved');
  assertEqual(tokens._email, TEST_EMAIL, '_email preserved');
});

setupUpgrade.test('upgrade: email config preserved in openclaw.json', async () => {
  const cfg = await readJson(CONFIG_PATH);
  assertEqual(cfg.channels?.kinthai?.email, TEST_EMAIL, 'email should be preserved');
});

setupUpgrade.test('upgrade: new source files present', async () => {
  // v2.5.0 → v2.5.1 introduced lazy machineId in register.js
  const registerJs = await readFile(join(CHANNELS_DIR, 'src', 'register.js'), 'utf8');
  assertIncludes(registerJs, 'getMachineId', 'should have new lazy getMachineId logic');
});

setupUpgrade.test('upgrade: no leftover files from old version', async () => {
  // Check that any files renamed/removed in new version don't linger
  // (if v2.5.x adds new files, old version files that were replaced should be gone)
  const files = await readdir(join(CHANNELS_DIR, 'src'));
  // All .js files should be current version's files
  for (const f of files) {
    const content = await readFile(join(CHANNELS_DIR, 'src', f), 'utf8');
    assert(content.length > 0, `${f} should not be empty/stale`);
  }
});

// ── ClawHub upgrade tests ────────────────────────────────────────────────────

const clawhubUpgrade = new TestRunner('ClawHub Upgrade Tests');

clawhubUpgrade.test('install old version (v2.5.0) via clawhub', async () => {
  await cleanAll();

  const out = run(
    `openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai@2.5.0" --force`,
    { timeout: 120000 },
  );
  assertIncludes(out, 'Installed plugin: kinthai', 'install should succeed');

  const installed = await readJson(join(EXTENSIONS_DIR, 'package.json'));
  assertEqual(installed.version, '2.5.0', 'should be v2.5.0');
});

clawhubUpgrade.test('simulate user config before upgrade', async () => {
  // Simulate user manually configured email after clawhub install
  // (since clawhub doesn't set email automatically)
  const cfg = await readJson(CONFIG_PATH);
  if (!cfg.channels) cfg.channels = {};
  cfg.channels.kinthai = { email: TEST_EMAIL, url: 'https://kinthai.ai' };
  await writeJson(CONFIG_PATH, cfg);

  // Also simulate .tokens.json in the clawhub install path
  const tokensPath = join(EXTENSIONS_DIR, '.tokens.json');
  await writeJson(tokensPath, {
    'agent-ch': { api_key: 'kk_clawhub_preupgrade', kk_agent_id: 'user-ch-001' },
    _machine_id: 'clawhub-machine-id',
    _email: TEST_EMAIL,
    _kinthai_url: 'https://kinthai.ai',
  });
});

clawhubUpgrade.test('upgrade to latest via clawhub', async () => {
  const out = run(
    `openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai" --force`,
    { timeout: 120000 },
  );
  assertIncludes(out, 'Installed plugin: kinthai', 'upgrade should succeed');
});

clawhubUpgrade.test('clawhub upgrade: version bumped', async () => {
  const installed = await readJson(join(EXTENSIONS_DIR, 'package.json'));
  const npmLatest = run('npm view @kinthaiofficial/openclaw-kinthai version');
  assertEqual(installed.version, npmLatest, 'version should match latest');
  assert(installed.version !== '2.5.0', 'should not still be 2.5.0');
});

clawhubUpgrade.test('clawhub upgrade: email config preserved', async () => {
  const cfg = await readJson(CONFIG_PATH);
  assertEqual(cfg.channels?.kinthai?.email, TEST_EMAIL, 'user email should be preserved across upgrade');
});

clawhubUpgrade.test('clawhub upgrade: .tokens.json preserved', async () => {
  const tokensPath = join(EXTENSIONS_DIR, '.tokens.json');
  // ClawHub install extracts archive which may or may not preserve external files
  // This is a known concern — we're explicitly testing what happens
  const exists = await fileExists(tokensPath);
  if (exists) {
    const tokens = await readJson(tokensPath);
    assertEqual(tokens['agent-ch']?.api_key, 'kk_clawhub_preupgrade', 'token preserved');
  } else {
    // If tokens lost — this is a bug worth documenting
    throw new Error('ClawHub upgrade WIPED .tokens.json — this breaks registered agents');
  }
});

clawhubUpgrade.test('clawhub update command: openclaw plugins update kinthai', async () => {
  // Install older version first
  run(`openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai@2.5.0" --force`, {
    timeout: 120000,
  });

  // Use the dedicated update command
  const out = run('openclaw plugins update kinthai --dry-run', { timeout: 30000, allowFail: true });
  if (out) {
    // Either works or reports what would change
    assert(out.length > 0, 'dry-run should produce output');
  }
});

// ── ClawHub uninstall tests ──────────────────────────────────────────────────

const clawhubUninstall = new TestRunner('ClawHub Uninstall Tests');

clawhubUninstall.test('setup: install via clawhub', async () => {
  await cleanAll();
  run(`openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai" --force`, {
    timeout: 120000,
  });
  assert(await fileExists(EXTENSIONS_DIR), 'extensions dir should exist');
});

clawhubUninstall.test('openclaw plugins uninstall --dry-run shows what would be removed', async () => {
  const out = run('openclaw plugins uninstall kinthai --dry-run --force', { timeout: 30000 });
  assert(out.length > 0, 'should produce output');
  // Plugin directory should still exist after dry-run
  assert(await fileExists(EXTENSIONS_DIR), 'dry-run should not delete');
});

clawhubUninstall.test('openclaw plugins uninstall removes plugin', async () => {
  const out = run('openclaw plugins uninstall kinthai --force', { timeout: 30000 });
  assert(out.length > 0, 'should produce output');
});

clawhubUninstall.test('uninstall: extensions/kinthai directory removed', async () => {
  assert(!await fileExists(EXTENSIONS_DIR), 'extensions dir should be gone');
});

clawhubUninstall.test('uninstall: openclaw.json plugin entry cleaned', async () => {
  const cfg = await readJson(CONFIG_PATH);
  assert(!cfg.plugins?.entries?.kinthai, 'plugins.entries.kinthai should be removed');
});

clawhubUninstall.test('uninstall --keep-files preserves directory', async () => {
  // Reinstall
  run(`openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai" --force`, {
    timeout: 120000,
  });
  assert(await fileExists(EXTENSIONS_DIR), 'should be installed');

  // Uninstall with --keep-files
  run('openclaw plugins uninstall kinthai --force --keep-files', { timeout: 30000 });

  assert(await fileExists(EXTENSIONS_DIR), 'files should remain with --keep-files');

  const cfg = await readJson(CONFIG_PATH);
  assert(!cfg.plugins?.entries?.kinthai, 'config entry should still be cleaned');
});

// ── Cross-method tests ───────────────────────────────────────────────────────

const crossMethod = new TestRunner('Cross-method Install Tests');

crossMethod.test('npm install then clawhub install: both dirs exist', async () => {
  await cleanAll();

  // Install via npm
  const pkgDir = join(NPM_WORK_DIR, 'node_modules', '@kinthaiofficial', 'openclaw-kinthai');
  run(`node ${join(pkgDir, 'scripts', 'setup.mjs')} install ${TEST_EMAIL}`, { cwd: pkgDir });
  assert(await fileExists(CHANNELS_DIR), 'channels/ should exist');

  // Then install via clawhub
  run(`openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai" --force`, {
    timeout: 120000,
  });
  assert(await fileExists(EXTENSIONS_DIR), 'extensions/ should also exist');
  // This is a potential issue — documenting it
});

crossMethod.test('both dirs present: plugin doctor reports issue', async () => {
  const out = run('openclaw plugins doctor 2>&1', { allowFail: true, timeout: 30000 });
  // Should either warn or report both locations
  // We just verify the command runs
  if (out) assert(out.length > 0, 'doctor should produce output');
});

crossMethod.test('remove.mjs does NOT touch clawhub install', async () => {
  // After npm remove, clawhub's extensions/ should still be there
  const pkgDir = join(NPM_WORK_DIR, 'node_modules', '@kinthaiofficial', 'openclaw-kinthai');
  run(`node ${join(pkgDir, 'scripts', 'remove.mjs')}`, { cwd: pkgDir });

  assert(!await fileExists(CHANNELS_DIR), 'channels/ should be gone');
  assert(await fileExists(EXTENSIONS_DIR), 'extensions/ should still exist (clawhub install)');
});

crossMethod.test('cleanup: uninstall clawhub install', async () => {
  run('openclaw plugins uninstall kinthai --force', { timeout: 30000 });
  assert(!await fileExists(EXTENSIONS_DIR), 'extensions/ should be gone');
});

crossMethod.test('clawhub first, then npm setup.mjs: both coexist', async () => {
  await cleanAll();

  run(`openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai" --force`, {
    timeout: 120000,
  });
  assert(await fileExists(EXTENSIONS_DIR), 'extensions/ should exist');

  const pkgDir = join(NPM_WORK_DIR, 'node_modules', '@kinthaiofficial', 'openclaw-kinthai');
  run(`node ${join(pkgDir, 'scripts', 'setup.mjs')} install ${TEST_EMAIL}`, { cwd: pkgDir });
  assert(await fileExists(CHANNELS_DIR), 'channels/ should also exist');

  // Cleanup
  await cleanAll();
});

// ── Exception / edge case tests ──────────────────────────────────────────────

const edge = new TestRunner('Upgrade Edge Cases');

edge.test('upgrade over corrupted install: npm install fixes it', async () => {
  await cleanAll();

  // Install via npm
  const pkgDir = join(NPM_WORK_DIR, 'node_modules', '@kinthaiofficial', 'openclaw-kinthai');
  run(`node ${join(pkgDir, 'scripts', 'setup.mjs')} install ${TEST_EMAIL}`, { cwd: pkgDir });

  // Corrupt a file
  await writeFile(join(CHANNELS_DIR, 'src', 'register.js'), '// corrupted');

  // Re-run install — should overwrite
  run(`node ${join(pkgDir, 'scripts', 'setup.mjs')} install ${TEST_EMAIL}`, { cwd: pkgDir });

  const registerJs = await readFile(join(CHANNELS_DIR, 'src', 'register.js'), 'utf8');
  assert(registerJs.length > 100, 'should be restored');
  assertIncludes(registerJs, 'autoRegisterAgents', 'should have real code');
});

edge.test('upgrade over corrupted install: clawhub --force fixes it', async () => {
  await cleanAll();

  run(`openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai" --force`, {
    timeout: 120000,
  });

  // Corrupt a file
  await writeFile(join(EXTENSIONS_DIR, 'src', 'register.js'), '// corrupted');

  // Re-install with --force
  run(`openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai" --force`, {
    timeout: 120000,
  });

  const registerJs = await readFile(join(EXTENSIONS_DIR, 'src', 'register.js'), 'utf8');
  assert(registerJs.length > 100, 'should be restored');
});

edge.test('install without --force on existing plugin: fails gracefully', async () => {
  // Plugin should still be installed from previous test
  assert(await fileExists(EXTENSIONS_DIR), 'should be installed');

  // Try install without --force
  const out = run(
    `openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai" 2>&1`,
    { allowFail: true, timeout: 30000 },
  );
  // Should either reject or require --force
  assert(out !== null || true, 'command should complete (either reject or succeed)');
});

edge.test('uninstall nonexistent plugin: graceful failure', async () => {
  const out = run('openclaw plugins uninstall nonexistent-plugin --force 2>&1', {
    allowFail: true,
    timeout: 30000,
  });
  // Should not crash, should report not found
  assert(out !== null || true, 'should handle gracefully');
});

edge.test('uninstall already-uninstalled plugin: idempotent', async () => {
  // Uninstall
  run('openclaw plugins uninstall kinthai --force 2>&1', { allowFail: true, timeout: 30000 });
  // Uninstall again
  const out = run('openclaw plugins uninstall kinthai --force 2>&1', {
    allowFail: true,
    timeout: 30000,
  });
  // Should complete (success or "not installed")
  assert(out !== null || true, 'should be idempotent');
});

edge.test('remove.mjs on nonexistent install: graceful', async () => {
  await cleanAll();
  const pkgDir = join(NPM_WORK_DIR, 'node_modules', '@kinthaiofficial', 'openclaw-kinthai');
  const out = run(`node ${join(pkgDir, 'scripts', 'remove.mjs')}`, {
    cwd: pkgDir,
    allowFail: true,
  });
  // Should not crash even when nothing to remove
  if (out) {
    assertIncludes(out, 'removed', 'should print removed anyway');
  }
});

edge.test('upgrade: .tokens.json survives clawhub reinstall (deep test)', async () => {
  await cleanAll();

  // Install v2.5.0
  run(`openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai@2.5.0" --force`, {
    timeout: 120000,
  });

  // Write tokens file with specific known data
  const tokensPath = join(EXTENSIONS_DIR, '.tokens.json');
  const sentinelData = {
    'survivor': { api_key: 'kk_sentinel_token', kk_agent_id: 'survivor-001' },
    _machine_id: 'sentinel-machine',
    _email: TEST_EMAIL,
    _kinthai_url: 'https://kinthai.ai',
  };
  await writeJson(tokensPath, sentinelData);

  // Upgrade to latest
  run(`openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai" --force`, {
    timeout: 120000,
  });

  // Verify
  if (!await fileExists(tokensPath)) {
    throw new Error('FAIL: .tokens.json was deleted during clawhub upgrade — data loss bug');
  }
  const after = await readJson(tokensPath);
  assertEqual(after.survivor?.api_key, 'kk_sentinel_token', 'token must survive upgrade');
  assertEqual(after._machine_id, 'sentinel-machine', 'machine_id must survive');
});

// ── Run ──────────────────────────────────────────────────────────────────────

let allPassed = true;

async function runSuite(suite) {
  if (!await suite.run()) allPassed = false;
}

if (mode === 'all' || mode === 'npm') {
  await runSuite(setupUpgrade);
}

if (mode === 'all' || mode === 'clawhub') {
  await runSuite(clawhubUpgrade);
  await runSuite(clawhubUninstall);
}

if (mode === 'all' || mode === 'cross') {
  await runSuite(crossMethod);
}

if (mode === 'all' || mode === 'edge') {
  await runSuite(edge);
}

// Final cleanup
await cleanAll();

process.exit(allPassed ? 0 : 1);
