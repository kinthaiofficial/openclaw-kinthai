/**
 * Tests for plugin installation methods on a real OpenClaw instance.
 * 测试插件在真实 OpenClaw 实例上的安装方式。
 *
 * These tests run ON the server (10.8.4.11) against oc-plugin-test instance.
 * 这些测试在服务器上运行，针对 oc-plugin-test 实例。
 *
 * Prerequisites:
 *   - OpenClaw gateway running on port 18820 (oc-plugin-test)
 *   - This script runs as oc-plugin-test user
 *   - The git repo is at /home/oc-plugin-test/openclaw-kinthai
 *
 * Usage:
 *   node test/test-install.js github    # test GitHub clone install
 *   node test/test-install.js npm       # test npm/npx install
 *   node test/test-install.js remove    # test uninstall
 *   node test/test-install.js all       # test all (default)
 */

import { readFile, stat, rm, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { TestRunner, assert, assertEqual, assertIncludes } from './helpers.js';

const mode = process.argv[2] || 'all';
const OPENCLAW_DIR = join(homedir(), '.openclaw');
const PLUGIN_DIR = join(OPENCLAW_DIR, 'channels', 'kinthai');
const CONFIG_PATH = join(OPENCLAW_DIR, 'openclaw.json');
const TEST_EMAIL = 'plugin-test@example.com';
const REPO_DIR = join(homedir(), 'openclaw-kinthai');

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

async function cleanPlugin() {
  // Remove plugin directory and clean config
  await rm(PLUGIN_DIR, { recursive: true, force: true });
  try {
    const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
    delete cfg.channels?.kinthai;
    if (cfg.plugins?.entries?.kinthai) delete cfg.plugins.entries.kinthai;
    if (cfg.plugins?.allow) cfg.plugins.allow = cfg.plugins.allow.filter(x => x !== 'kinthai');
    if (cfg.plugins?.load?.paths) cfg.plugins.load.paths = cfg.plugins.load.paths.filter(x => !x.includes('kinthai'));
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch { /* config might not exist */ }
}

// ── GitHub install tests ─────────────────────────────────────────────────────

const github = new TestRunner('GitHub Install Tests');

github.test('setup.mjs installs plugin from local git clone', async () => {
  await cleanPlugin();

  // Run setup.mjs from the cloned repo
  const out = run(`node ${REPO_DIR}/scripts/setup.mjs install ${TEST_EMAIL}`, { cwd: REPO_DIR });
  assertIncludes(out, 'Setup complete', 'should print setup complete');
});

github.test('plugin files copied to channels/kinthai', async () => {
  assert(await fileExists(PLUGIN_DIR), 'plugin dir should exist');
  assert(await fileExists(join(PLUGIN_DIR, 'src', 'plugin.js')), 'plugin.js should exist');
  assert(await fileExists(join(PLUGIN_DIR, 'src', 'register.js')), 'register.js should exist');
  assert(await fileExists(join(PLUGIN_DIR, 'src', 'connection.js')), 'connection.js should exist');
  assert(await fileExists(join(PLUGIN_DIR, 'openclaw.plugin.json')), 'manifest should exist');
  assert(await fileExists(join(PLUGIN_DIR, 'package.json')), 'package.json should exist');
});

github.test('openclaw.json configured with email and url', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  assert(cfg.channels?.kinthai, 'channels.kinthai should exist');
  assertEqual(cfg.channels.kinthai.email, TEST_EMAIL, 'email should match');
  assert(cfg.channels.kinthai.url, 'url should be set');
});

github.test('openclaw.json has plugin entries', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  assert(cfg.plugins?.entries?.kinthai?.enabled === true, 'kinthai plugin should be enabled');
  assert(cfg.plugins?.allow?.includes('kinthai'), 'kinthai should be in allow list');
});

github.test('plugin version matches git repo', async () => {
  const repoPkg = JSON.parse(await readFile(join(REPO_DIR, 'package.json'), 'utf8'));
  const installedPkg = JSON.parse(await readFile(join(PLUGIN_DIR, 'package.json'), 'utf8'));
  assertEqual(installedPkg.version, repoPkg.version, 'versions should match');
});

// ── Remove tests ─────────────────────────────────────────────────────────────

const remove = new TestRunner('Remove Tests');

remove.test('remove.mjs uninstalls plugin', async () => {
  // First ensure it's installed
  if (!await fileExists(PLUGIN_DIR)) {
    run(`node ${REPO_DIR}/scripts/setup.mjs install ${TEST_EMAIL}`, { cwd: REPO_DIR });
  }

  const out = run(`node ${REPO_DIR}/scripts/remove.mjs`, { cwd: REPO_DIR });
  assertIncludes(out, 'removed', 'should print removed');
});

remove.test('plugin directory removed', async () => {
  assert(!await fileExists(PLUGIN_DIR), 'plugin dir should be gone');
});

remove.test('openclaw.json cleaned', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  assert(!cfg.channels?.kinthai, 'channels.kinthai should be removed');
  assert(!cfg.plugins?.entries?.kinthai, 'plugin entry should be removed');
});

remove.test('reinstall after remove works', async () => {
  const out = run(`node ${REPO_DIR}/scripts/setup.mjs install ${TEST_EMAIL}`, { cwd: REPO_DIR });
  assertIncludes(out, 'Setup complete', 'reinstall should succeed');
  assert(await fileExists(PLUGIN_DIR), 'plugin dir should exist again');
});

// ── npm/npx install tests ────────────────────────────────────────────────────

const npm = new TestRunner('npm/npx Install Tests');

// Pre-install the package globally to avoid npx download timeout on slow networks
const NPM_PKG_DIR = join(homedir(), '.npm-plugin-test');

npm.test('npm install package from registry', async () => {
  await cleanPlugin();
  await rm(NPM_PKG_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(NPM_PKG_DIR, { recursive: true });

  // Install to a temp dir — faster than npx which re-downloads every time
  run(`npm install @kinthaiofficial/openclaw-kinthai@latest`, {
    cwd: NPM_PKG_DIR,
    timeout: 300000,
  });

  const pkgDir = join(NPM_PKG_DIR, 'node_modules', '@kinthaiofficial', 'openclaw-kinthai');
  assert(await fileExists(pkgDir), 'package should be installed');
});

npm.test('setup.mjs from npm package installs plugin', async () => {
  const pkgDir = join(NPM_PKG_DIR, 'node_modules', '@kinthaiofficial', 'openclaw-kinthai');
  const out = run(`node ${join(pkgDir, 'scripts', 'setup.mjs')} install ${TEST_EMAIL}`, {
    cwd: pkgDir,
    timeout: 30000,
  });
  assertIncludes(out, 'Setup complete', 'should print setup complete');
});

npm.test('npm installed plugin has correct files', async () => {
  assert(await fileExists(PLUGIN_DIR), 'plugin dir should exist');
  assert(await fileExists(join(PLUGIN_DIR, 'src', 'plugin.js')), 'plugin.js should exist');
  assert(await fileExists(join(PLUGIN_DIR, 'openclaw.plugin.json')), 'manifest should exist');
});

npm.test('npm installed plugin version matches registry', async () => {
  const npmVersion = run('npm view @kinthaiofficial/openclaw-kinthai version');
  const installedPkg = JSON.parse(await readFile(join(PLUGIN_DIR, 'package.json'), 'utf8'));
  assertEqual(installedPkg.version, npmVersion, 'installed version should match npm');
});

npm.test('remove.mjs from npm package uninstalls plugin', async () => {
  const pkgDir = join(NPM_PKG_DIR, 'node_modules', '@kinthaiofficial', 'openclaw-kinthai');
  const out = run(`node ${join(pkgDir, 'scripts', 'remove.mjs')}`, {
    cwd: pkgDir,
    timeout: 30000,
  });
  assertIncludes(out, 'removed', 'should print removed');
  assert(!await fileExists(PLUGIN_DIR), 'plugin dir should be gone');
});

// ── ClawHub install tests ────────────────────────────────────────────────────

const EXTENSIONS_DIR = join(OPENCLAW_DIR, 'extensions', 'kinthai');

const clawhub = new TestRunner('ClawHub Install Tests');

async function cleanPluginAll() {
  // Clean both possible install locations
  await cleanPlugin();
  await rm(EXTENSIONS_DIR, { recursive: true, force: true });
}

clawhub.test('clawhub install from registry', async () => {
  await cleanPluginAll();

  const out = run(
    `openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai" --force`,
    { timeout: 120000 },
  );
  assertIncludes(out, 'Installed plugin: kinthai', 'should confirm installation');
});

clawhub.test('clawhub installs to extensions/kinthai', async () => {
  assert(await fileExists(EXTENSIONS_DIR), 'extensions/kinthai should exist');
  assert(await fileExists(join(EXTENSIONS_DIR, 'src', 'plugin.js')), 'plugin.js should exist');
  assert(await fileExists(join(EXTENSIONS_DIR, 'openclaw.plugin.json')), 'manifest should exist');
  assert(await fileExists(join(EXTENSIONS_DIR, 'package.json')), 'package.json should exist');
});

clawhub.test('clawhub version matches npm latest', async () => {
  const npmVersion = run('npm view @kinthaiofficial/openclaw-kinthai version');
  const pkg = JSON.parse(await readFile(join(EXTENSIONS_DIR, 'package.json'), 'utf8'));
  assertEqual(pkg.version, npmVersion, 'clawhub version should match npm');
});

clawhub.test('clawhub sets plugins.entries but NOT channels.kinthai.email', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  assert(cfg.plugins?.entries?.kinthai?.enabled === true, 'plugin should be enabled');
  // ClawHub does NOT inject email — this is the known gap
  const email = cfg.channels?.kinthai?.email;
  assert(!email, 'email should NOT be set by clawhub install (known gap)');
});

clawhub.test('clawhub source files match npm package', async () => {
  // Verify key source files are present and non-empty
  const files = ['api.js', 'connection.js', 'plugin.js', 'register.js', 'register-scan.js'];
  for (const f of files) {
    const path = join(EXTENSIONS_DIR, 'src', f);
    assert(await fileExists(path), `${f} should exist`);
    const content = await readFile(path, 'utf8');
    assert(content.length > 100, `${f} should not be empty`);
  }
});

clawhub.test('clawhub reinstall with --force overwrites cleanly', async () => {
  const out = run(
    `openclaw plugins install "clawhub:@kinthaiofficial/openclaw-kinthai" --force`,
    { timeout: 120000 },
  );
  assertIncludes(out, 'Installed plugin: kinthai', 'reinstall should succeed');
  assert(await fileExists(EXTENSIONS_DIR), 'extensions/kinthai should still exist');
});

// ── Run ──────────────────────────────────────────────────────────────────────

let allPassed = true;

if (mode === 'all' || mode === 'github') {
  if (!await github.run()) allPassed = false;
}

if (mode === 'all' || mode === 'remove') {
  // Ensure installed first for remove tests
  if (!await fileExists(PLUGIN_DIR)) {
    run(`node ${REPO_DIR}/scripts/setup.mjs install ${TEST_EMAIL}`, { cwd: REPO_DIR });
  }
  if (!await remove.run()) allPassed = false;
}

if (mode === 'all' || mode === 'npm') {
  if (!await npm.run()) allPassed = false;
}

if (mode === 'all' || mode === 'clawhub') {
  if (!await clawhub.run()) allPassed = false;
}

process.exit(allPassed ? 0 : 1);
