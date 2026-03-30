/**
 * Auto-registration: scan all OpenClaw agents and register them with KinthAI.
 * 自动注册：扫描所有 OpenClaw agent 并注册到 KinthAI。
 *
 * Called on plugin startup. For each agent without a token in .tokens.json,
 * calls POST /register and saves the api_key.
 * 插件启动时调用。对每个没有 token 的 agent，调用注册 API 并保存 api_key。
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Auto-register all agents on this OpenClaw instance with KinthAI.
 * 自动注册本 OpenClaw 实例上的所有 agent 到 KinthAI。
 *
 * @param {string} kinthaiUrl - KinthAI server URL
 * @param {string} email - Human owner's email
 * @param {string} tokensFilePath - Path to .tokens.json
 * @param {object} log - Logger
 * @returns {object|null} tokens map, or null on failure
 */
export async function autoRegisterAgents(kinthaiUrl, email, tokensFilePath, log, openclawDir = null) {
  log?.info?.('[KK-REG] Auto-registration scan starting...');

  // Resolve OpenClaw directory: prefer explicit param, fallback to deriving from tokensFilePath, then search
  // 解析 OpenClaw 目录：优先用传入的参数，其次从 tokensFilePath 推导，最后搜索
  if (!openclawDir) {
    // tokensFilePath is typically .openclaw/channels/kinthai/.tokens.json → go up 3 levels
    const derived = join(tokensFilePath, '..', '..', '..');
    try {
      await stat(join(derived, 'openclaw.json'));
      openclawDir = derived;
    } catch {
      openclawDir = await findOpenClawDir();
    }
  }
  if (!openclawDir) {
    log?.warn?.('[KK-REG] Could not find OpenClaw directory');
    return null;
  }

  // Read machine ID from identity/device.json
  // OpenClaw v2026.3.28+ only creates identity on first RPC call (gateway.identity.get),
  // not during onboard or gateway startup. If missing, trigger creation via gateway RPC.
  // OpenClaw v2026.3.28+ 只在首次 RPC 调用时创建 identity，不在 onboard 或 gateway 启动时创建。
  // 如果不存在，通过 gateway RPC 触发创建。
  let machineId;
  try {
    const deviceJson = JSON.parse(await readFile(join(openclawDir, 'identity', 'device.json'), 'utf8'));
    machineId = deviceJson.deviceId;
  } catch {
    // identity not yet created — try to trigger via gateway RPC
    // identity 尚未创建 — 尝试通过 gateway RPC 触发
    log?.info?.('[KK-REG] identity/device.json not found, triggering creation via gateway RPC...');
    machineId = await triggerIdentityCreation(openclawDir, log);
  }

  if (!machineId) {
    log?.warn?.('[KK-REG] Could not obtain deviceId — gateway may not be running');
    return null;
  }

  // Load existing tokens
  // 加载现有 tokens
  let tokensData = {};
  try {
    tokensData = JSON.parse(await readFile(tokensFilePath, 'utf8'));
  } catch {
    // File doesn't exist yet — will be created
    // 文件不存在 — 将会创建
  }

  // Scan all agents
  // 扫描所有 agent
  const agentIds = await scanAgents(openclawDir, log);
  if (agentIds.length === 0) {
    log?.info?.('[KK-REG] No agents found — skipping registration');
    return null;
  }

  let registered = 0;
  let skipped = 0;

  for (const agentId of agentIds) {
    // Skip if already has token
    // 跳过已有 token 的 agent
    if (tokensData[agentId]) {
      skipped++;
      continue;
    }

    try {
      log?.info?.(`[KK-REG] Registering agent "${agentId}" with email=${email}`);

      const res = await fetch(`${kinthaiUrl}/api/v1/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          openclaw_machine_id: machineId,
          openclaw_agent_id: agentId,
        }),
      });

      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        if (body.api_key) {
          // Recover token from server (same machine re-registering)
          // 从服务器恢复 token（同一机器重新注册）
          tokensData[agentId] = { api_key: body.api_key, kk_agent_id: body.kk_agent_id || agentId };
          registered++;
          log?.info?.(`[KK-REG] Agent "${agentId}" already registered — token recovered`);
        } else {
          log?.warn?.(`[KK-REG] Agent "${agentId}" conflict (409): ${body.message || 'unknown'}`);
          skipped++;
        }
        continue;
      }

      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        log?.warn?.(`[KK-REG] Agent "${agentId}" — machine owner mismatch (403): ${body.message || ''}`);
        continue;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        log?.warn?.(`[KK-REG] Agent "${agentId}" registration failed (${res.status}): ${body.message || 'unknown error'}`);
        continue;
      }

      const data = await res.json();
      tokensData[agentId] = { api_key: data.api_key, kk_agent_id: data.kk_agent_id || agentId };
      registered++;
      log?.info?.(`[KK-REG] Agent "${agentId}" registered — kk_agent_id=${data.kk_agent_id}`);
    } catch (err) {
      log?.warn?.(`[KK-REG] Agent "${agentId}" registration error: ${err.message}`);
    }
  }

  // Save tokens with metadata
  // 保存 tokens（含元数据）
  if (registered > 0 || !tokensData._machine_id) {
    tokensData._machine_id = machineId;
    tokensData._email = email;
    tokensData._kinthai_url = kinthaiUrl;
    await writeFile(tokensFilePath, JSON.stringify(tokensData, null, 2), { mode: 0o600 });
    try { const { chmod } = await import('node:fs/promises'); await chmod(tokensFilePath, 0o600); } catch { /* best-effort */ }
    log?.info?.(`[KK-REG] Tokens saved (mode 0600) — registered=${registered} skipped=${skipped}`);
  }

  // Return agent tokens only (exclude metadata fields)
  // 只返回 agent tokens（排除元数据字段）
  const tokens = {};
  for (const [k, v] of Object.entries(tokensData)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'object' && v?.api_key) {
      tokens[k] = v.api_key;
    } else if (typeof v === 'string' && v) {
      tokens[k] = v;  // backward compat: old format was plain string
    }
  }

  return Object.keys(tokens).length > 0 ? tokens : null;
}

/**
 * Find the OpenClaw config directory.
 * 查找 OpenClaw 配置目录。
 */
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

/**
 * Trigger identity creation via gateway RPC.
 * OpenClaw v2026.3.28+ creates identity/device.json only on first gateway.identity.get call.
 * We connect to the local gateway WebSocket and call this RPC method.
 *
 * 通过 gateway RPC 触发 identity 创建。
 * OpenClaw v2026.3.28+ 只在首次 gateway.identity.get 调用时创建 identity/device.json。
 * 我们连接本地 gateway WebSocket 并调用此 RPC 方法。
 */
async function triggerIdentityCreation(openclawDir, log) {
  try {
    // Read gateway port and auth token from config
    const cfg = JSON.parse(await readFile(join(openclawDir, 'openclaw.json'), 'utf8'));
    const port = cfg.gateway?.port || 18789;
    const token = typeof cfg.gateway?.auth?.token === 'string' ? cfg.gateway.auth.token : '';

    // Try CLI first (simplest and most reliable)
    const { execSync } = await import('node:child_process');
    try {
      execSync('openclaw health', { timeout: 10000, stdio: 'pipe' });
    } catch { /* ignore errors — identity may still have been created */ }

    // Check if identity was created
    try {
      const deviceJson = JSON.parse(await readFile(join(openclawDir, 'identity', 'device.json'), 'utf8'));
      if (deviceJson.deviceId) {
        log?.info?.(`[KK-REG] Identity created via CLI — deviceId=${deviceJson.deviceId.slice(0, 16)}...`);
        return deviceJson.deviceId;
      }
    } catch { /* not created yet */ }

    // Fallback: direct WebSocket RPC call to gateway
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
        // Authenticate then request identity
        ws.send(JSON.stringify({ method: 'connect', params: { token, scopes: ['admin'] } }));
      };

      ws.onmessage = async (evt) => {
        try {
          const msg = JSON.parse(typeof evt.data === 'string' ? evt.data : evt.data.toString());
          if (msg.method === 'connect' && msg.result) {
            // Connected — now request identity
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

/**
 * Scan OpenClaw agents directory for agent IDs.
 * 扫描 OpenClaw agents 目录获取 agent ID 列表。
 */
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
    // 没有 agents 目录
  }
  return ids;
}
