/**
 * KinthAI Channel Plugin for OpenClaw
 * OpenClaw 的 KinthAI 频道插件
 *
 * Entry point — uses new Plugin SDK (openclaw/plugin-sdk/*).
 * 入口文件 — 使用新 Plugin SDK。
 *
 * Module layout:
 *   plugin.js      — Channel definition (createChatChannelPlugin)
 *   api.js         — HTTP requests (KinthaiApi)
 *   connection.js  — WebSocket lifecycle
 *   messages.js    — Message handling + AI dispatch
 *   files.js       — File download/upload/extraction
 *   storage.js     — Local session storage
 *   tokens.js      — Multi-agent token management
 *   utils.js       — Pure utility functions
 *   updater.js     — Remote check / upgrade / restart
 *
 * Error codes: KK-I001~I020 / KK-W001~W008 / KK-E001~E007 / KK-V001~V003
 */

import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/core';
import { kinthaiPlugin, setRuntime, agentRegistry } from './plugin.js';
import { lastModelInfo } from './messages.js';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── Role context cache for before_prompt_build ──────────────────────────────
// conversationId → { data, timestamp }
const roleContextCache = new Map();
const ROLE_CACHE_TTL = 5 * 60_000; // 5 min fallback TTL

async function getRoleContext(api, conversationId) {
  const cached = roleContextCache.get(conversationId);
  if (cached && Date.now() - cached.timestamp < ROLE_CACHE_TTL) {
    return cached.data;
  }
  try {
    const data = await api.getRoleContext(conversationId);
    roleContextCache.set(conversationId, { data, timestamp: Date.now() });
    return data;
  } catch {
    return cached?.data || null; // return stale if fetch fails
  }
}

// Called by connection.js when role.updated event received
export function invalidateRoleContext(conversationId) {
  roleContextCache.delete(conversationId);
}

function buildRoleContextPrompt(roleCtx, selfPublicId) {
  const lines = [];
  lines.push(`[KinthAI Group: ${roleCtx.group_name}]`);

  // Group owner
  const owner = roleCtx.members?.find(m => m.id === roleCtx.created_by);
  if (owner) {
    lines.push(`[Group owner: ${owner.display_name}]`);
  }

  // My role
  const self = roleCtx.members?.find(m => m.id === selfPublicId);
  const myRole = self?.role;
  if (myRole && roleCtx.roles) {
    const roleDef = roleCtx.roles.find(r => r.role_id === myRole);
    const desc = roleDef?.description || '';
    lines.push(`[Your role: ${roleDef?.name || myRole}${desc ? ' — ' + desc : ''}]`);
  }

  // Group by role
  const roled = {};
  const unroled = [];
  for (const m of roleCtx.members || []) {
    if (m.role) {
      if (!roled[m.role]) roled[m.role] = [];
      roled[m.role].push(m);
    } else {
      unroled.push(m);
    }
  }

  const hasRoles = roleCtx.roles && roleCtx.roles.length > 0;
  if (hasRoles) {
    const roledCount = Object.values(roled).reduce((sum, arr) => sum + arr.length, 0);
    lines.push(`[Role Members: ${roledCount}]`);
    for (const role of roleCtx.roles) {
      const members = roled[role.role_id] || [];
      const desc = role.description ? role.description.slice(0, 50) : '';
      const descLabel = desc ? ` — ${desc}${(role.description || '').length > 50 ? '...' : ''}` : '';
      const memberLabels = members.map(m => {
        const you = m.id === selfPublicId ? ' ← you' : '';
        return `${m.display_name} (${m.type})${you}`;
      });
      lines.push(`${role.name}${descLabel}: ${memberLabels.join(', ') || '(none)'}`);
    }
    if (unroled.length > 0) {
      lines.push(`[Other Members: ${unroled.length}]`);
      for (const m of unroled) {
        const you = m.id === selfPublicId ? ' ← you' : '';
        lines.push(`${m.display_name} (${m.type})${you}`);
      }
    }
  } else {
    lines.push(`[Members: ${(roleCtx.members || []).length}]`);
    for (const m of roleCtx.members || []) {
      const you = m.id === selfPublicId ? ' ← you' : '';
      lines.push(`${m.display_name} (${m.type})${you}`);
    }
  }

  return lines.join('\n');
}

// Prevent concurrent auto-registration for the same agentId
// 防止同一 agentId 并发自动注册
const registeringAgents = new Set();

export default defineChannelPluginEntry({
  id: 'kinthai',
  name: 'KinthAI',
  description: 'KinthAI messaging platform — collaborative network for humans and AI agents',
  plugin: kinthaiPlugin,
  setRuntime,
  registerFull(api) {
    const log = api.logger || console;
    const __dirname = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
    const tokensFilePath = path.join(__dirname, '..', '.tokens.json');

    // Inject group role context into system prompt
    // 将群角色信息注入 system prompt
    api.on('before_prompt_build', async (event) => {
      try {
        const sessionKey = event.sessionKey || '';
        // Extract group conversation ID from session key: agent:xxx:kinthai:group:conv_xxx
        const groupMatch = sessionKey.match(/:kinthai:group:(.+)$/);
        if (!groupMatch) return; // DM or non-kinthai session

        const conversationId = groupMatch[1];
        // Find the agent's API and identity from registry
        const agentIdMatch = sessionKey.match(/^agent:([^:]+):/);
        const agentId = agentIdMatch?.[1];

        // Try to find a registered agent to get API access
        let agentInfo = agentId ? agentRegistry.get(agentId) : null;
        if (!agentInfo) {
          // Fallback: use first registered agent's API
          for (const info of agentRegistry.values()) {
            agentInfo = info;
            break;
          }
        }
        if (!agentInfo) return;

        const roleCtx = await getRoleContext(agentInfo.api, conversationId);
        if (!roleCtx) return;

        const prompt = buildRoleContextPrompt(roleCtx, agentInfo.selfPublicId);
        return { prependSystemContext: prompt };
      } catch {
        return; // fail silently
      }
    });

    // Capture LLM model info + auto-register new agents
    // 捕获 LLM 模型信息 + 自动注册新 agent
    api.on('agent_end', async (ctx) => {
      log.info(`[KK-I013] agent_end fired — success=${ctx.success} keys=${Object.keys(ctx).join(',')}`);

      // Capture LLM model info from assistant messages
      // 从助手消息中捕获 LLM 模型信息
      if (ctx.success) {
        const msgs = ctx.messages || [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m?.role === 'assistant' && m?.model) {
            const provider = m.provider || '';
            const model = provider ? `${provider}/${m.model}` : m.model;
            lastModelInfo.value = { model, usage: m.usage || null, ts: Date.now() };
            break;
          }
        }
      }

      // Auto-register unknown agents
      // 自动注册未知 agent
      const agentId = ctx.agentId ?? (ctx.sessionKey?.startsWith('agent:')
        ? ctx.sessionKey.split(':')[1] : null);
      if (!agentId) return;

      let tokensData;
      try {
        tokensData = JSON.parse(await readFile(tokensFilePath, 'utf8'));
      } catch { return; }

      if (tokensData[agentId]) return;

      const machineId = tokensData._machine_id;
      const email = tokensData._email;
      const kinthaiUrl = tokensData._kinthai_url;
      if (!machineId || !email || !kinthaiUrl) return;

      if (registeringAgents.has(agentId)) return;
      registeringAgents.add(agentId);

      try {
        log.info(`[KK-I018] Auto-registering new agent "${agentId}" with KinthAI`);

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
            await writeFile(tokensFilePath, JSON.stringify(tokensData, null, 2), { mode: 0o600 });
            log.info(`[KK-I019] Agent "${agentId}" already registered — token recovered`);
          } else {
            log.warn(`[KK-I019] Agent "${agentId}" conflict (409): ${body.message || 'unknown'}`);
          }
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          log.warn(`[KK-W006] Auto-register failed (${res.status}): ${body.message || 'unknown error'}`);
          return;
        }

        const data = await res.json();
        tokensData[agentId] = { api_key: data.api_key, kk_agent_id: data.kk_agent_id || agentId };
        await writeFile(tokensFilePath, JSON.stringify(tokensData, null, 2), { mode: 0o600 });
        log.info(`[KK-I020] Agent "${agentId}" registered — kk_agent_id=${data.kk_agent_id}`);
      } catch (err) {
        log.warn(`[KK-W007] Auto-register error for "${agentId}": ${err.message}`);
      } finally {
        registeringAgents.delete(agentId);
      }
    });
  },
});
