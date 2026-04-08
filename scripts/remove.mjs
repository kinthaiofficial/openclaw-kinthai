#!/usr/bin/env node
/**
 * KinthAI Plugin Remove Script (cross-platform)
 * KinthAI 插件卸载脚本（跨平台）
 *
 * Usage:
 *   node remove.mjs
 *
 * Steps:
 *   1. Remove plugin directory
 *   2. Clean kinthai config from openclaw.json
 *   3. Restart OpenClaw
 */

import { readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';

const isWin = platform() === 'win32';
const green = (s) => isWin ? s : `\x1b[32m${s}\x1b[0m`;
const red = (s) => isWin ? s : `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => isWin ? s : `\x1b[36m${s}\x1b[0m`;
const bold = (s) => isWin ? s : `\x1b[1m${s}\x1b[0m`;

const ok = (msg) => console.log(green('[OK]'), msg);
const err = (msg) => console.error(red('[ERROR]'), msg);
const step = (msg) => console.log(cyan('==>'), msg);

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

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

async function main() {
  console.log(`\n${bold('KinthAI Plugin Remove')}\n`);

  const openclawDir = await findOpenClawDir();
  if (!openclawDir) {
    err('Could not find OpenClaw directory');
    process.exit(1);
  }

  // Step 1: Remove plugin directory
  step('Removing plugin files...');
  const pluginDir = join(openclawDir, 'channels', 'kinthai');
  try {
    await rm(pluginDir, { recursive: true, force: true });
    ok('Plugin directory removed');
  } catch {
    ok('Plugin directory not found (already removed)');
  }

  // Step 2: Clean openclaw.json
  step('Cleaning openclaw.json...');
  const configPath = join(openclawDir, 'openclaw.json');
  try {
    const cfg = JSON.parse(await readFile(configPath, 'utf8'));
    let changed = false;

    if (cfg.channels?.kinthai) {
      delete cfg.channels.kinthai;
      changed = true;
    }

    const paths = cfg.plugins?.load?.paths;
    if (Array.isArray(paths)) {
      const filtered = paths.filter(p => !p.includes('kinthai'));
      if (filtered.length !== paths.length) {
        cfg.plugins.load.paths = filtered;
        changed = true;
      }
    }

    if (cfg.plugins?.entries?.['openclaw-kinthai']) {
      delete cfg.plugins.entries['openclaw-kinthai'];
      changed = true;
    }
    // Also clean legacy entry name
    if (cfg.plugins?.entries?.kinthai) {
      delete cfg.plugins.entries.kinthai;
      changed = true;
    }

    const allow = cfg.plugins?.allow;
    if (Array.isArray(allow)) {
      const filtered = allow.filter(a => a !== 'openclaw-kinthai' && a !== 'kinthai');
      if (filtered.length !== allow.length) {
        cfg.plugins.allow = filtered;
        changed = true;
      }
    }

    if (changed) {
      await writeFile(configPath, JSON.stringify(cfg, null, 2));
      ok('Config cleaned');
    } else {
      ok('Config already clean');
    }
  } catch (e) {
    err(`Could not update ${configPath}: ${e.message}`);
  }

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
    const signalFile = join(openclawDir, 'workspace', '.restart-openclaw');
    try {
      await mkdir(dirname(signalFile), { recursive: true });
      await writeFile(signalFile, `remove ${new Date().toISOString()}`);
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

  console.log(`\n${bold('KinthAI plugin removed.')}\n`);
}

// Export for setup.mjs, also run directly if called as script
export { main };
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('remove.mjs')) {
  main().catch(e => { err(e.message); process.exit(1); });
}
