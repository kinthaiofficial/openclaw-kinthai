/**
 * Remote admin command handler: plugin.check / plugin.upgrade / plugin.restart.
 * 远程管理命令处理：插件检查 / 升级 / 重启。
 *
 * This module only does file I/O — network calls are in updater-download.js.
 * 此模块只做文件 I/O — 网络请求在 updater-download.js 中。
 *
 * Dynamically imported by connection.js on first admin.command event,
 * so upgrading this file takes effect on the next command (no restart needed).
 */

import { readFile, writeFile, mkdir, readdir, unlink, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { downloadFiles, reportCommandResult } from './updater-download.js';

const __dirname = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, '..');

export async function handleAdminCommand(event, api, state, log) {
  const { command_id, command_type, payload } = event;
  log?.info?.(`[KK-UPD] admin.command received: ${command_type} (id=${command_id})`);

  try {
    switch (command_type) {
      case 'plugin.check':
        await executeCheck(command_id, api, state, log);
        break;
      case 'plugin.upgrade':
        await executeUpgrade(command_id, payload, api, state, log);
        break;
      case 'plugin.restart':
        await executeRestart(command_id, api, log);
        break;
      default:
        log?.warn?.(`[KK-UPD] Unknown command_type: ${command_type}`);
    }
  } catch (err) {
    log?.error?.(`[KK-UPD] Command ${command_type} failed: ${err.message}`);
    await reportCommandResult(api, command_id, 'failed', { error: err.message });
  }
}

// ── plugin.check ──────────────────────────────────────────────────────────────

async function executeCheck(command_id, api, state, log) {
  const running_version = state.pluginVersion || 'unknown';

  let disk_version = 'unknown';
  try {
    const pkg = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8'));
    disk_version = pkg.version || 'unknown';
  } catch { /* ignore */ }

  let latest_version = 'unknown';
  let manifestFiles = [];
  try {
    const manifest = await api._fetch('/api/v1/plugin/latest-version');
    latest_version = manifest.version || 'unknown';
    manifestFiles = manifest.files || [];
  } catch (err) {
    log?.warn?.(`[KK-UPD] Failed to check latest-version: ${err.message}`);
  }

  const missing_files = [];
  const extra_files = [];

  if (manifestFiles.length > 0) {
    const manifestSet = new Set(manifestFiles);
    for (const f of manifestFiles) {
      try {
        await readFile(path.join(pluginDir, 'src', f));
      } catch {
        missing_files.push(f);
      }
    }
    try {
      const dirEntries = await readdir(path.join(pluginDir, 'src'));
      for (const entry of dirEntries) {
        if (entry.startsWith('.')) continue;
        if (!manifestSet.has(entry) && entry.endsWith('.js')) {
          extra_files.push(entry);
        }
      }
    } catch { /* ignore */ }
  }

  const result = {
    running_version,
    disk_version,
    latest_version,
    needs_restart: running_version !== disk_version,
    files_ok: missing_files.length === 0,
    missing_files,
    extra_files,
  };

  log?.info?.(`[KK-UPD] check result: running=${running_version} disk=${disk_version} latest=${latest_version}`);
  await reportCommandResult(api, command_id, 'completed', result);
}

// ── plugin.upgrade ────────────────────────────────────────────────────────────

async function executeUpgrade(command_id, payload, api, state, log) {
  const manifest = await api._fetch('/api/v1/plugin/latest-version');
  const { version, files, download_url } = manifest;

  if (!files || files.length === 0) {
    await reportCommandResult(api, command_id, 'failed', { error: 'No files in manifest' });
    return;
  }

  const srcDir = path.join(pluginDir, 'src');
  const tmpDir = path.join(pluginDir, '.upgrade-tmp');
  const baseUrl = api.baseUrl;

  try {
    await mkdir(tmpDir, { recursive: true });

    // Download files via updater-download.js (network-only module)
    await downloadFiles(baseUrl, download_url, files, async (fileName, content) => {
      await writeFile(path.join(tmpDir, fileName), content, 'utf8');
    }, log);

    // Remove old source files (never touch .tokens.json or hidden files)
    const oldEntries = await readdir(srcDir);
    for (const entry of oldEntries) {
      if (entry.startsWith('.')) continue;
      try {
        await unlink(path.join(srcDir, entry));
      } catch { /* skip */ }
    }

    const newEntries = await readdir(tmpDir);
    for (const entry of newEntries) {
      await rename(path.join(tmpDir, entry), path.join(srcDir, entry));
    }

    await rm(tmpDir, { recursive: true, force: true });

    let newVersion = 'unknown';
    try {
      const newPkg = JSON.parse(await readFile(path.join(pluginDir, 'package.json'), 'utf8'));
      newVersion = newPkg.version || 'unknown';
    } catch { /* ignore */ }

    log?.info?.(`[KK-UPD] Upgrade complete: ${state.pluginVersion} → ${newVersion} (disk). Restart needed.`);

    await reportCommandResult(api, command_id, 'completed', {
      old_version: state.pluginVersion,
      new_version: newVersion,
      expected_version: version,
      files_replaced: files.length,
    });

    if (payload?.restart) {
      await triggerRestart(log);
    }
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ── plugin.restart ────────────────────────────────────────────────────────────

async function executeRestart(command_id, api, log) {
  await reportCommandResult(api, command_id, 'completed', { message: 'Restart signal sent' });
  await triggerRestart(log);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function triggerRestart(log) {
  const restartFile = path.join(homedir(), '.openclaw/workspace/.restart-openclaw');
  try {
    await writeFile(restartFile, `restart-requested-${Date.now()}`);
    log?.info?.('[KK-UPD] Restart signal written');
  } catch (err) {
    log?.warn?.(`[KK-UPD] Failed to write restart signal: ${err.message}`);
  }
}
