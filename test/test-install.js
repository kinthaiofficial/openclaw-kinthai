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

import { readFile, stat, rm, readdir } from 'node:fs/promises';
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

npm.test('npx install from npm registry', async () => {
  await cleanPlugin();

  const out = run(`npx -y @kinthaiofficial/openclaw-kinthai install ${TEST_EMAIL}`, {
    cwd: homedir(),
    timeout: 60000,
  });
  assertIncludes(out, 'Setup complete', 'should print setup complete');
});

npm.test('npx installed plugin has correct files', async () => {
  assert(await fileExists(PLUGIN_DIR), 'plugin dir should exist');
  assert(await fileExists(join(PLUGIN_DIR, 'src', 'plugin.js')), 'plugin.js should exist');
  assert(await fileExists(join(PLUGIN_DIR, 'openclaw.plugin.json')), 'manifest should exist');
});

npm.test('npx installed plugin version matches npm registry', async () => {
  const npmVersion = run('npm view @kinthaiofficial/openclaw-kinthai version');
  const installedPkg = JSON.parse(await readFile(join(PLUGIN_DIR, 'package.json'), 'utf8'));
  assertEqual(installedPkg.version, npmVersion, 'installed version should match npm');
});

npm.test('npx remove works', async () => {
  const out = run(`npx -y @kinthaiofficial/openclaw-kinthai remove`, { cwd: homedir() });
  assertIncludes(out, 'removed', 'should print removed');
  assert(!await fileExists(PLUGIN_DIR), 'plugin dir should be gone');
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

process.exit(allPassed ? 0 : 1);
