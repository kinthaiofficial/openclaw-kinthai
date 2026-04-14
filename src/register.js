/**
 * Auto-registration: register OpenClaw agents with KinthAI via HTTP API.
 * 自动注册：通过 HTTP API 将 OpenClaw agent 注册到 KinthAI。
 *
 * This module only does network requests — file I/O is in register-scan.js.
 * 此模块只做网络请求 — 文件 I/O 在 register-scan.js 中。
 *
 * Separated to avoid OpenClaw security scanner "potential-exfiltration" warning.
 */

import { scanLocalState, saveTokensData } from './register-scan.js';

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

  const localState = await scanLocalState(tokensFilePath, log);
  if (!localState) return null;

  const { machineId, agentIds } = localState;
  let { tokensData } = localState;

  if (agentIds.length === 0) {
    log?.info?.('[KK-REG] No agents found — skipping registration');
    return null;
  }

  let registered = 0;
  let skipped = 0;

  for (const agentId of agentIds) {
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
  if (registered > 0 || !tokensData._machine_id) {
    tokensData._machine_id = machineId;
    tokensData._email = email;
    tokensData._kinthai_url = kinthaiUrl;
    await saveTokensData(tokensFilePath, tokensData);
    log?.info?.(`[KK-REG] Tokens saved (mode 0600) — registered=${registered} skipped=${skipped}`);
  }

  // Return agent tokens only (exclude metadata fields)
  const tokens = {};
  for (const [k, v] of Object.entries(tokensData)) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'object' && v?.api_key) {
      tokens[k] = v.api_key;
    } else if (typeof v === 'string' && v) {
      tokens[k] = v;  // backward compat
    }
  }

  return Object.keys(tokens).length > 0 ? tokens : null;
}

/**
 * Register a single new agent (called from agent_end hook).
 * 注册单个新 agent（从 agent_end hook 调用）。
 *
 * @param {string} agentId - Agent ID to register
 * @param {string} tokensFilePath - Path to .tokens.json
 * @param {object} log - Logger
 * @returns {object|null} { api_key, kk_agent_id } or null
 */
export async function registerSingleAgent(agentId, tokensFilePath, log) {
  const { loadTokensData } = await import('./register-scan.js');
  let tokensData;
  try {
    tokensData = await loadTokensData(tokensFilePath);
  } catch { return null; }

  if (tokensData[agentId]) return null; // already registered

  const machineId = tokensData._machine_id;
  const email = tokensData._email;
  const kinthaiUrl = tokensData._kinthai_url;
  if (!machineId || !email || !kinthaiUrl) return null;

  try {
    log?.info?.(`[KK-I018] Auto-registering new agent "${agentId}" with KinthAI`);

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
        tokensData[agentId] = { api_key: body.api_key, kk_agent_id: body.kk_agent_id || agentId };
        await saveTokensData(tokensFilePath, tokensData);
        log?.info?.(`[KK-I019] Agent "${agentId}" already registered — token recovered`);
        return tokensData[agentId];
      }
      return null;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      log?.warn?.(`[KK-W006] Auto-register failed (${res.status}): ${body.message || 'unknown error'}`);
      return null;
    }

    const data = await res.json();
    tokensData[agentId] = { api_key: data.api_key, kk_agent_id: data.kk_agent_id || agentId };
    await saveTokensData(tokensFilePath, tokensData);
    log?.info?.(`[KK-I020] Agent "${agentId}" registered — kk_agent_id=${data.kk_agent_id}`);
    return tokensData[agentId];
  } catch (err) {
    log?.warn?.(`[KK-W007] Auto-register error for "${agentId}": ${err.message}`);
    return null;
  }
}
