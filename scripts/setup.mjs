#!/usr/bin/env node
/**
 * KinthAI Plugin Installer — thin wrapper over openclaw commands.
 * KinthAI 插件安装器 — openclaw 命令的薄 wrapper。
 *
 * Usage:
 *   npx -y @kinthaiofficial/openclaw-kinthai install <email>
 *   npx -y @kinthaiofficial/openclaw-kinthai update
 *   npx -y @kinthaiofficial/openclaw-kinthai uninstall
 *   npx -y @kinthaiofficial/openclaw-kinthai remove
 *
 * All commands delegate to `openclaw plugins/config` for consistency with
 * ClawHub installs. npx only adds email injection and gateway restart.
 * 所有命令 delegate 给 openclaw 原生命令，保持和 ClawHub 安装一致。
 * npx 只负责 email 注入和 gateway 重启。
 */

import { execFileSync, execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

const isWin = platform() === 'win32';
const green = (s) => isWin ? s : `\x1b[32m${s}\x1b[0m`;
const red   = (s) => isWin ? s : `\x1b[31m${s}\x1b[0m`;
const cyan  = (s) => isWin ? s : `\x1b[36m${s}\x1b[0m`;
const bold  = (s) => isWin ? s : `\x1b[1m${s}\x1b[0m`;

const ok   = (msg) => console.log(green('[OK]'), msg);
const err  = (msg) => console.error(red('[ERROR]'), msg);
const step = (msg) => console.log(cyan('==>'), msg);

// ── Helpers ──────────────────────────────────────────────────────────────────

function runOC(args, { allowFail = false } = {}) {
  try {
    return execFileSync('openclaw', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`openclaw ${args.join(' ')} failed: ${e.stderr?.toString() || e.message}`);
  }
}

function hasOpenclaw() {
  try {
    execFileSync('openclaw', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function restartGateway() {
  // Best-effort cross-platform restart. openclaw plugins install updates the
  // in-memory state when possible, but restarting ensures the plugin loads.
  const os = platform();
  step('Restarting OpenClaw gateway...');

  if (os === 'darwin') {
    try { execSync('pkill -f "openclaw gateway"', { stdio: 'ignore' }); } catch {}
    await new Promise(r => setTimeout(r, 2000));
    try {
      execSync('nohup bash -l -c "openclaw gateway" > /tmp/openclaw-restart.log 2>&1 &');
      ok('Gateway restarting (macOS)');
    } catch { err('Failed to restart gateway'); }
    return;
  }

  if (os === 'win32') {
    try { execSync('taskkill /F /IM openclaw.exe', { stdio: 'ignore' }); } catch {}
    await new Promise(r => setTimeout(r, 2000));
    try {
      execSync('start /B openclaw gateway');
      ok('Gateway restarting (Windows)');
    } catch { err('Failed to restart gateway'); }
    return;
  }

  // Linux: try systemd first, then signal file, then process
  for (const svc of ['openclaw', 'openclaw-gateway']) {
    try {
      execSync(`systemctl restart ${svc}`, { stdio: 'ignore' });
      ok(`Gateway restarted (systemd: ${svc})`);
      return;
    } catch {}
  }
  for (const svc of ['openclaw', 'openclaw-gateway']) {
    try {
      execSync(`systemctl --user restart ${svc}`, { stdio: 'ignore' });
      ok(`Gateway restarted (user systemd: ${svc})`);
      return;
    } catch {}
  }
  try { execSync('pkill -f "openclaw gateway"', { stdio: 'ignore' }); } catch {}
  await new Promise(r => setTimeout(r, 2000));
  try {
    execSync('nohup openclaw gateway > /tmp/openclaw-restart.log 2>&1 &');
    ok('Gateway restarting (process)');
  } catch { err('Failed to restart gateway'); }
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function cmdInstall(email) {
  if (!email || !email.includes('@')) {
    err('install requires an email argument');
    printHelp();
    process.exit(1);
  }

  console.log(`\n${bold('KinthAI Plugin Installer')}\n`);

  // 1. Pack + install via openclaw (extensions/kinthai/).
  // Use npm pack so openclaw only sees files[] — avoids scanning node_modules/test.
  // 先 npm pack，只把 files[] 声明的文件打成 tgz，避免扫 node_modules/test 目录。
  step('Packing plugin...');
  const tmpDir = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
  let tgzPath;
  try {
    const packOut = execFileSync('npm', ['pack', '--silent', '--pack-destination', tmpDir], {
      cwd: PKG_ROOT,
      encoding: 'utf8',
    }).trim();
    tgzPath = `${tmpDir}/${packOut.split('\n').pop()}`;
    step('Installing plugin via openclaw plugins install...');
    runOC(['plugins', 'install', tgzPath, '--force']);
    ok('Plugin installed');
  } finally {
    try { execFileSync('rm', ['-rf', tmpDir]); } catch {}
  }

  // 2. Set email via openclaw config set
  step('Configuring email...');
  runOC(['config', 'set', 'channels.kinthai.email', email]);
  ok(`Email set: ${email}`);

  // 3. Restart gateway so plugin loads
  await restartGateway();

  console.log(`
${bold('Setup complete!')}

  Plugin:  @kinthaiofficial/openclaw-kinthai
  Email:   ${email}

The plugin will automatically register all your agents
and connect them. Should be live in ~10 seconds.
`);
}

async function cmdUpdate() {
  console.log(`\n${bold('KinthAI Plugin Updater')}\n`);

  step('Updating plugin via openclaw plugins update...');
  const out = runOC(['plugins', 'update', 'kinthai'], { allowFail: true });
  if (out === null) {
    // Fallback: pack + reinstall (avoids scanning node_modules)
    step('Update command unavailable, reinstalling from package...');
    const tmpDir = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
    try {
      const packOut = execFileSync('npm', ['pack', '--silent', '--pack-destination', tmpDir], {
        cwd: PKG_ROOT,
        encoding: 'utf8',
      }).trim();
      const tgzPath = `${tmpDir}/${packOut.split('\n').pop()}`;
      runOC(['plugins', 'install', tgzPath, '--force']);
    } finally {
      try { execFileSync('rm', ['-rf', tmpDir]); } catch {}
    }
  }
  ok('Plugin updated');

  await restartGateway();
  console.log(`\n${bold('Update complete!')}\n`);
}

async function cmdUninstall({ deleteAccount = false } = {}) {
  console.log(`\n${bold('KinthAI Plugin Uninstall')}\n`);

  // 1. Uninstall via openclaw (removes extensions/kinthai/ + plugins.entries + channels.kinthai)
  step('Uninstalling plugin via openclaw plugins uninstall...');
  runOC(['plugins', 'uninstall', 'kinthai', '--force'], { allowFail: true });
  ok('Plugin uninstalled');

  if (deleteAccount) {
    // 2. Remove account + trigger onAccountRemoved hook (clears credentials/kinthai/)
    step('Removing account and clearing credentials...');
    runOC(['channels', 'remove', 'kinthai', '--delete'], { allowFail: true });
    ok('Account and credentials removed');
  } else {
    console.log(`
${cyan('Note:')} credentials/kinthai/ is preserved. To purge everything, use:
  npx -y @kinthaiofficial/openclaw-kinthai remove
`);
  }

  await restartGateway();
  console.log(`\n${bold(deleteAccount ? 'Removed!' : 'Uninstalled!')}\n`);
}

function printHelp() {
  console.log(`
${bold('KinthAI Plugin — npx commands')}

Usage:
  npx -y @kinthaiofficial/openclaw-kinthai install <email>
  npx -y @kinthaiofficial/openclaw-kinthai update
  npx -y @kinthaiofficial/openclaw-kinthai uninstall
  npx -y @kinthaiofficial/openclaw-kinthai remove

Commands:
  install <email>   Install plugin and set your email.
  update            Update plugin to the latest version (keeps email + tokens).
  uninstall         Remove plugin code; keep email config and credentials.
  remove            Remove everything (code + email + credentials).

Examples:
  npx -y @kinthaiofficial/openclaw-kinthai install alice@example.com
  npx -y @kinthaiofficial/openclaw-kinthai update
  npx -y @kinthaiofficial/openclaw-kinthai uninstall
  npx -y @kinthaiofficial/openclaw-kinthai remove
`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const command = process.argv[2];
  const arg = process.argv[3];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  if (!hasOpenclaw()) {
    err('openclaw CLI not found in PATH');
    err('Install openclaw first: npm install -g openclaw');
    process.exit(1);
  }

  try {
    if (command === 'install') {
      // Support both: `install <email>` and `install` (with email as 2nd arg)
      // Also tolerate `<email>` as first arg (shortcut, but not documented)
      await cmdInstall(arg || (command.includes('@') ? command : null));
      return;
    }
    if (command === 'update') {
      await cmdUpdate();
      return;
    }
    if (command === 'uninstall') {
      await cmdUninstall({ deleteAccount: false });
      return;
    }
    if (command === 'remove') {
      await cmdUninstall({ deleteAccount: true });
      return;
    }
    // Shortcut: `npx ... <email>` → treat as `install <email>`
    if (command.includes('@')) {
      await cmdInstall(command);
      return;
    }
    err(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}

main().catch(e => { err(e.message); process.exit(1); });
