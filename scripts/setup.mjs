#!/usr/bin/env node
/**
 * KinthAI Plugin Setup Script (cross-platform)
 * KinthAI 插件安装脚本（跨平台）
 *
 * Usage:
 *   node setup.mjs <email>
 *
 * Steps:
 *   1. Install plugin via openclaw CLI (or npm fallback)
 *   2. Configure openclaw.json with url + email
 *   3. Restart OpenClaw
 */

import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';

const KINTHAI_URL = process.env.KINTHAI_URL || 'https://kinthai.ai';
const PACKAGE = '@kinthaiofficial/openclaw-kinthai';

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
const email = process.argv[2];
if (!email || !email.includes('@')) {
  console.log(`
${bold('KinthAI Plugin Setup')}

Usage: node setup.mjs <email>

  email — human owner email (required)

Examples:
  node setup.mjs alice@example.com
  KINTHAI_URL=https://my-server.com node setup.mjs alice@example.com
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
  // Windows
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

// ── Run command ──
function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return null;
  }
}

// ── Main ──
async function main() {
  console.log(`\n${bold('KinthAI Plugin Setup')}\n`);

  // Step 1: Install plugin (skip if already installed)
  step('Checking plugin...');
  const openclawDir = await findOpenClawDir();
  const pluginIndex = openclawDir
    ? join(openclawDir, 'channels', 'kinthai', 'src', 'index.js')
    : null;
  let alreadyInstalled = false;
  if (pluginIndex) {
    try { await stat(pluginIndex); alreadyInstalled = true; } catch { /* not installed */ }
  }

  if (alreadyInstalled) {
    ok('Plugin already installed');
  } else {
    step('Installing plugin...');
    let installed = run(`openclaw plugins install ${PACKAGE}`);
    if (installed === null) {
      step('openclaw CLI failed, trying npm...');
      installed = run(`npm install -g ${PACKAGE}`);
      if (installed === null) {
        err('Failed to install plugin. Please install manually:');
        console.log(`  openclaw plugins install ${PACKAGE}`);
        process.exit(1);
      }
    }
    ok('Plugin installed');
  }

  // Step 2: Configure openclaw.json
  step('Configuring openclaw.json...');
  if (!openclawDir) {
    err('Could not find OpenClaw directory (~/.openclaw/openclaw.json)');
    err('Make sure OpenClaw is installed and has been initialized');
    process.exit(1);
  }

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

  await writeFile(configPath, JSON.stringify(cfg, null, 2));
  ok(`Configured: url=${KINTHAI_URL} email=${email}`);

  // Step 3: Restart OpenClaw
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
    // Linux: try signal file first, then systemd
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

  // Summary
  console.log(`
${bold('Setup complete!')}

  KinthAI URL: ${KINTHAI_URL}
  Email:       ${email}
  Config:      ${configPath}

The plugin will automatically register all your agents
and connect them. Should be live in ~10 seconds.
`);
}

main().catch(e => { err(e.message); process.exit(1); });
