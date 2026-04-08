#!/usr/bin/env node
/**
 * KinthAI Plugin Installer (cross-platform)
 * KinthAI 插件安装器（跨平台）
 *
 * Usage:
 *   npx -y @kinthaiofficial/openclaw-kinthai install <email>
 *
 * Steps:
 *   1. Copy plugin files to ~/.openclaw/channels/kinthai/
 *   2. Create node_modules/openclaw symlink for SDK resolution
 *   3. Configure openclaw.json with url + email
 *   4. Restart OpenClaw
 */

import { readFile, writeFile, stat, mkdir, cp, symlink, readlink } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const KINTHAI_URL = process.env.KINTHAI_URL || 'https://kinthai.ai';

// ── Colors ──
const isWin = platform() === 'win32';
const green = (s) => isWin ? s : `\x1b[32m${s}\x1b[0m`;
const red = (s) => isWin ? s : `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => isWin ? s : `\x1b[36m${s}\x1b[0m`;
const bold = (s) => isWin ? s : `\x1b[1m${s}\x1b[0m`;

const ok = (msg) => console.log(green('[OK]'), msg);
const err = (msg) => console.error(red('[ERROR]'), msg);
const step = (msg) => console.log(cyan('==>'), msg);

// ── Args ──
const command = process.argv[2];
const email = process.argv[3] || process.argv[2];

if (command === 'remove' || command === 'uninstall') {
  const { main: removeMain } = await import('./remove.mjs');
  await removeMain();
  process.exit(0);
}

if (!email || !email.includes('@')) {
  console.log(`
${bold('KinthAI Plugin Installer')}

Usage:
  npx -y @kinthaiofficial/openclaw-kinthai install <email>
  npx -y @kinthaiofficial/openclaw-kinthai remove

  email — human owner email (required for install)

Examples:
  npx -y @kinthaiofficial/openclaw-kinthai install alice@example.com
  KINTHAI_URL=https://my-server.com npx -y @kinthaiofficial/openclaw-kinthai install alice@example.com
`);
  process.exit(1);
}

// ── Find OpenClaw directory ──
async function findOpenClawDir() {
  const candidates = [
    join(homedir(), '.openclaw'),
    '/home/openclaw/.openclaw',
    '/home/ubuntu/.openclaw',
    '/home/claw/.openclaw',
    '/root/.openclaw',
  ];
  if (process.env.LOCALAPPDATA) {
    candidates.push(join(process.env.LOCALAPPDATA, 'openclaw'));
  }
  for (const dir of candidates) {
    try {
      await stat(join(dir, 'openclaw.json'));
      return dir;
    } catch { /* not here */ }
  }
  return null;
}

// ── Find OpenClaw module path ──
async function findOpenClawModule() {
  // Check common locations
  const candidates = [
    '/opt/homebrew/lib/node_modules/openclaw',
    '/usr/local/lib/node_modules/openclaw',
    '/usr/lib/node_modules/openclaw',
    join(homedir(), '.npm/lib/node_modules/openclaw'),
  ];
  // Try npm root -g
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.unshift(join(globalRoot, 'openclaw'));
  } catch { /* ignore */ }
  for (const p of candidates) {
    try {
      await stat(join(p, 'package.json'));
      return p;
    } catch { /* not here */ }
  }
  return null;
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

// ── Main ──
async function main() {
  console.log(`\n${bold('KinthAI Plugin Installer')}\n`);

  // Step 1: Find OpenClaw directory
  step('Finding OpenClaw directory...');
  const openclawDir = await findOpenClawDir();
  if (!openclawDir) {
    err('Could not find OpenClaw directory (~/.openclaw/openclaw.json)');
    err('Make sure OpenClaw is installed and has been initialized');
    process.exit(1);
  }
  ok(`OpenClaw directory: ${openclawDir}`);

  // Step 2: Copy plugin files
  const pluginDir = join(openclawDir, 'channels', 'kinthai');
  step(`Installing plugin to ${pluginDir} ...`);

  await mkdir(pluginDir, { recursive: true });
  await cp(join(PKG_ROOT, 'src'), join(pluginDir, 'src'), { recursive: true });
  await cp(join(PKG_ROOT, 'skills'), join(pluginDir, 'skills'), { recursive: true });
  await cp(join(PKG_ROOT, 'package.json'), join(pluginDir, 'package.json'));
  await cp(join(PKG_ROOT, 'openclaw.plugin.json'), join(pluginDir, 'openclaw.plugin.json'));
  // Copy scripts for future remove
  await mkdir(join(pluginDir, 'scripts'), { recursive: true });
  await cp(join(PKG_ROOT, 'scripts', 'remove.mjs'), join(pluginDir, 'scripts', 'remove.mjs'));
  ok('Plugin files copied');

  // Step 3: Create node_modules/openclaw symlink for SDK module resolution
  step('Linking OpenClaw SDK...');
  const openclawModule = await findOpenClawModule();
  if (openclawModule) {
    const linkDir = join(pluginDir, 'node_modules');
    const linkPath = join(linkDir, 'openclaw');
    await mkdir(linkDir, { recursive: true });
    try {
      const existing = await readlink(linkPath).catch(() => null);
      if (existing !== openclawModule) {
        await symlink(openclawModule, linkPath).catch(() => {});
      }
    } catch {
      await symlink(openclawModule, linkPath).catch(() => {});
    }
    ok(`SDK linked: ${openclawModule}`);
  } else {
    err('Could not find OpenClaw module — plugin SDK imports may fail');
    err('Try: ln -sf $(npm root -g)/openclaw ' + join(pluginDir, 'node_modules', 'openclaw'));
  }

  // Step 4: Configure openclaw.json
  step('Configuring openclaw.json...');
  const configPath = join(openclawDir, 'openclaw.json');
  let cfg;
  try {
    cfg = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    err(`Could not read ${configPath}`);
    process.exit(1);
  }

  if (!cfg.channels) cfg.channels = {};
  const existing = cfg.channels.kinthai || {};
  cfg.channels.kinthai = {
    ...existing,
    url: KINTHAI_URL,
    email,
  };

  // Add plugin load path
  if (!cfg.plugins) cfg.plugins = {};
  if (!cfg.plugins.load) cfg.plugins.load = {};
  if (!cfg.plugins.load.paths) cfg.plugins.load.paths = [];
  if (!cfg.plugins.load.paths.includes(pluginDir)) {
    cfg.plugins.load.paths.push(pluginDir);
  }
  if (!cfg.plugins.allow) cfg.plugins.allow = [];
  // Clean up legacy id if present
  cfg.plugins.allow = cfg.plugins.allow.filter(x => x !== 'openclaw-kinthai');
  if (!cfg.plugins.allow.includes('kinthai')) {
    cfg.plugins.allow.push('kinthai');
  }
  if (!cfg.plugins.entries) cfg.plugins.entries = {};
  delete cfg.plugins.entries['openclaw-kinthai']; // remove legacy
  cfg.plugins.entries['kinthai'] = { enabled: true };

  await writeFile(configPath, JSON.stringify(cfg, null, 2));
  ok(`Configured: url=${KINTHAI_URL} email=${email}`);

  // Step 5: Restart OpenClaw
  step('Restarting OpenClaw...');
  const os = platform();

  if (os === 'darwin') {
    run('pkill -f "openclaw gateway"');
    await new Promise(r => setTimeout(r, 2000));
    run('nohup bash -l -c "openclaw gateway" > /tmp/openclaw-restart.log 2>&1 &');
    ok('OpenClaw restarting (macOS)');
  } else if (os === 'win32') {
    run('taskkill /F /IM openclaw.exe');
    await new Promise(r => setTimeout(r, 2000));
    run('start /B openclaw gateway');
    ok('OpenClaw restarting (Windows)');
  } else {
    const signalFile = join(openclawDir, 'workspace', '.restart-openclaw');
    try {
      await mkdir(dirname(signalFile), { recursive: true });
      await writeFile(signalFile, `setup ${new Date().toISOString()}`);
      ok('Restart signal written (Docker mode)');
    } catch {
      if (run('systemctl restart openclaw') !== null) {
        ok('OpenClaw restarted (systemd)');
      } else if (run('systemctl --user restart openclaw-gateway') !== null) {
        ok('OpenClaw restarted (user systemd)');
      } else {
        run('pkill -f "openclaw gateway"');
        await new Promise(r => setTimeout(r, 2000));
        run('nohup openclaw gateway > /tmp/openclaw-restart.log 2>&1 &');
        ok('OpenClaw restarting (process)');
      }
    }
  }

  console.log(`
${bold('Setup complete!')}

  KinthAI URL: ${KINTHAI_URL}
  Email:       ${email}
  Plugin:      ${pluginDir}
  Config:      ${configPath}

The plugin will automatically register all your agents
and connect them. Should be live in ~10 seconds.
`);
}

main().catch(e => { err(e.message); process.exit(1); });
