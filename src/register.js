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
export async function autoRegisterAgents(kinthaiUrl, email, tokensFilePath, log) {
  log?.info?.('[KK-REG] Auto-registration scan starting...');

  // Read machine ID from OpenClaw identity
  // 从 OpenClaw identity 读取机器 ID
  const openclawDir = await findOpenClawDir();
  if (!openclawDir) {
    log?.warn?.('[KK-REG] Could not find OpenClaw directory');
    return null;
  }

  let machineId;
  try {
    const deviceJson = JSON.parse(await readFile(join(openclawDir, 'identity', 'device.json'), 'utf8'));
    machineId = deviceJson.deviceId;
  } catch {
    log?.warn?.('[KK-REG] Could not read identity/device.json');
    return null;
  }

  if (!machineId) {
    log?.warn?.('[KK-REG] deviceId is empty');
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
    await writeFile(tokensFilePath, JSON.stringify(tokensData, null, 2));
    log?.info?.(`[KK-REG] Tokens saved — registered=${registered} skipped=${skipped}`);
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
      await stat(join(dir, 'identity', 'device.json'));
      return dir;
    } catch { /* not here */ }
  }
  return null;
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
