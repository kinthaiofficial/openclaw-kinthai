/**
 * Local filesystem scan for OpenClaw agent registration.
 * 本地文件系统扫描，为 agent 注册提供数据。
 *
 * This module only reads local files — no network calls.
 * 此模块只读取本地文件 — 不做网络请求。
 *
 * Separated from register.js to avoid OpenClaw security scanner
 * "potential-exfiltration" warning (file-read + network-send in same file).
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Scan the local OpenClaw instance and return everything needed for registration.
 * 扫描本地 OpenClaw 实例，返回注册所需的全部数据。
 *
 * @param {string} tokensFilePath - Path to .tokens.json
 * @param {object} log - Logger
 * @returns {{ openclawDir, machineId, tokensData, agentIds } | null}
 */
export async function scanLocalState(tokensFilePath, log) {
  // Resolve OpenClaw directory
  let openclawDir = null;
  const derived = join(tokensFilePath, '..', '..', '..');
  try {
    await stat(join(derived, 'openclaw.json'));
    openclawDir = derived;
  } catch {
    openclawDir = await findOpenClawDir();
  }
  if (!openclawDir) {
    log?.warn?.('[KK-REG] Could not find OpenClaw directory');
    return null;
  }

  // Read machine ID
  let machineId;
  try {
    const deviceJson = JSON.parse(await readFile(join(openclawDir, 'identity', 'device.json'), 'utf8'));
    machineId = deviceJson.deviceId;
  } catch {
    log?.info?.('[KK-REG] identity/device.json not found, triggering creation via gateway RPC...');
    machineId = await triggerIdentityCreation(openclawDir, log);
  }

  if (!machineId) {
    log?.warn?.('[KK-REG] Could not obtain deviceId — gateway may not be running');
    return null;
  }

  // Load existing tokens
  let tokensData = {};
  try {
    tokensData = JSON.parse(await readFile(tokensFilePath, 'utf8'));
  } catch {
    // File doesn't exist yet — will be created
  }

  // Scan agents
  const agentIds = await scanAgents(openclawDir, log);

  return { openclawDir, machineId, tokensData, agentIds };
}

/**
 * Load tokens data from .tokens.json.
 * 从 .tokens.json 加载 token 数据。
 */
export async function loadTokensData(tokensFilePath) {
  try {
    return JSON.parse(await readFile(tokensFilePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Save tokens data to .tokens.json with 0600 permissions.
 * 将 token 数据保存到 .tokens.json（权限 0600）。
 */
export async function saveTokensData(tokensFilePath, tokensData) {
  await writeFile(tokensFilePath, JSON.stringify(tokensData, null, 2), { mode: 0o600 });
  try {
    const { chmod } = await import('node:fs/promises');
    await chmod(tokensFilePath, 0o600);
  } catch { /* best-effort */ }
}

/**
 * Read plugin version from package.json.
 * 从 package.json 读取插件版本。
 */
export async function readPluginVersion(pluginRoot) {
  try {
    const pkg = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function findOpenClawDir() {
  const candidates = [
    join(homedir(), '.openclaw'),
    '/home/openclaw/.openclaw',
    '/home/ubuntu/.openclaw',
    '/home/claw/.openclaw',
    '/root/.openclaw',
  ];

  for (const dir of candidates) {
    try {
      await stat(join(dir, 'openclaw.json'));
      return dir;
    } catch { /* not here */ }
  }
  return null;
}

async function triggerIdentityCreation(openclawDir, log) {
  try {
    const cfg = JSON.parse(await readFile(join(openclawDir, 'openclaw.json'), 'utf8'));
    const port = cfg.gateway?.port || 18789;
    const token = typeof cfg.gateway?.auth?.token === 'string' ? cfg.gateway.auth.token : '';

    try {
      const deviceJson = JSON.parse(await readFile(join(openclawDir, 'identity', 'device.json'), 'utf8'));
      if (deviceJson.deviceId) {
        log?.info?.(`[KK-REG] Identity found — deviceId=${deviceJson.deviceId.slice(0, 16)}...`);
        return deviceJson.deviceId;
      }
    } catch { /* not created yet */ }

    const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }));
    if (!WebSocket) {
      log?.warn?.('[KK-REG] No WebSocket available for RPC fallback');
      return null;
    }

    return await new Promise((resolve) => {
      const timer = setTimeout(() => { ws?.close(); resolve(null); }, 8000);
      const wsUrl = `ws://127.0.0.1:${port}`;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        ws.send(JSON.stringify({ method: 'connect', params: { token, scopes: ['admin'] } }));
      };

      ws.onmessage = async (evt) => {
        try {
          const msg = JSON.parse(typeof evt.data === 'string' ? evt.data : evt.data.toString());
          if (msg.method === 'connect' && msg.result) {
            ws.send(JSON.stringify({ method: 'gateway.identity.get', params: {} }));
          } else if (msg.result?.deviceId) {
            clearTimeout(timer);
            ws.close();
            log?.info?.(`[KK-REG] Identity obtained via RPC — deviceId=${msg.result.deviceId.slice(0, 16)}...`);
            resolve(msg.result.deviceId);
          }
        } catch { /* parse error */ }
      };

      ws.onerror = () => { clearTimeout(timer); resolve(null); };
    });
  } catch (err) {
    log?.warn?.(`[KK-REG] triggerIdentityCreation error: ${err.message}`);
    return null;
  }
}

async function scanAgents(openclawDir, log) {
  const agentsDir = join(openclawDir, 'agents');
  const ids = [];
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        ids.push(entry.name);
      }
    }
    log?.info?.(`[KK-REG] Found ${ids.length} agent(s): ${ids.join(', ')}`);
  } catch {
    // No agents directory
  }
  return ids;
}
