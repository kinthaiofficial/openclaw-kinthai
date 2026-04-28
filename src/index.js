/**
 * KinthAI Channel Plugin for OpenClaw
 * OpenClaw 的 KinthAI 频道插件
 *
 * Entry point — uses new Plugin SDK (openclaw/plugin-sdk/*).
 * 入口文件 — 使用新 Plugin SDK。
 *
 * Module layout:
 *   plugin.js         — Channel definition (createChatChannelPlugin)
 *   api.js            — HTTP requests (KinthaiApi)
 *   connection.js     — WebSocket lifecycle
 *   messages.js       — Message handling + AI dispatch
 *   files.js          — File download/upload/extraction
 *   file-sync.js      — File sync protocol (admin.file_request / admin.file_push)
 *   storage.js        — Local session storage
 *   tokens.js         — Multi-agent token management
 *   register.js       — Agent registration (network only)
 *   register-scan.js  — Local filesystem scan (file I/O only)
 *   updater.js        — Remote check / upgrade (file I/O only)
 *   updater-download.js — Plugin file download (network only)
 *   utils.js          — Pure utility functions
 *
 * Error codes: KK-I001~I020 / KK-W001~W008 / KK-E001~E007 / KK-V001~V003
 */

import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/core';
import { kinthaiPlugin, setRuntime, agentRegistry, TOKENS_FILE_PATH, KINTHAI_URL, getRuntime } from './plugin.js';
import { lastModelInfo } from './messages.js';
import { registerSingleAgent } from './register.js';
import { setupDynamicRegistry } from './tools/dynamic-registry.js';
import { applyAlsoAllowPatch } from './config-patch.js';

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
    return cached?.data || null; // return stale on error
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
const registeringAgents = new Set();

export default defineChannelPluginEntry({
  id: 'kinthai',
  name: 'KinthAI',
  description: 'KinthAI messaging platform — collaborative network for humans and AI agents',
  plugin: kinthaiPlugin,
  setRuntime,
  registerFull(api) {
    const log = api.logger || console;
    const tokensFilePath = TOKENS_FILE_PATH;

    // First-time setup: ensure `kinthai_*` is in tools.alsoAllow so plugin
    // tools survive strict profiles (e.g. tools.profile=messaging). Idempotent
    // — re-runs on every register but only writes when missing. Covers all
    // install paths (ClawHub / npx / manual unzip) since register always runs.
    // 首次启动写一次：把 kinthai_* 加进 tools.alsoAllow，让插件工具在严格
    // 白名单（如 messaging profile）下也能被 LLM 看到。幂等，重启不会反复写。
    applyAlsoAllowPatch(api, log);

    // Resolve email lazily from openclaw config (needed for auto-registering new agents).
    // 延迟从 openclaw 配置读取 email（注册新 agent 时需要）。
    async function getEmail() {
      try {
        const runtime = getRuntime();
        const cfg = runtime?.config?.loadConfig
          ? await runtime.config.loadConfig()
          : null;
        return cfg?.channels?.kinthai?.email || null;
      } catch {
        return null;
      }
    }

    // Inject group role context into system prompt
    api.on('before_prompt_build', async (event) => {
      try {
        const sessionKey = event.sessionKey || '';
        const groupMatch = sessionKey.match(/:kinthai:group:(.+)$/);
        if (!groupMatch) return;

        const conversationId = groupMatch[1];
        const agentIdMatch = sessionKey.match(/^agent:([^:]+):/);
        const agentId = agentIdMatch?.[1];

        let agentInfo = agentId ? agentRegistry.get(agentId) : null;
        if (!agentInfo) {
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
        return;
      }
    });

    // Capture LLM model info + auto-register new agents
    api.on('agent_end', async (ctx) => {
      log.info(`[KK-I013] agent_end fired — success=${ctx.success} keys=${Object.keys(ctx).join(',')}`);

      // Capture LLM model info from assistant messages
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

      // Auto-register unknown agents — delegated to register.js
      const agentId = ctx.agentId ?? (ctx.sessionKey?.startsWith('agent:')
        ? ctx.sessionKey.split(':')[1] : null);
      if (!agentId) return;
      if (registeringAgents.has(agentId)) return;
      registeringAgents.add(agentId);

      try {
        const email = await getEmail();
        if (!email) {
          log.warn(`[KK-W006] Cannot auto-register "${agentId}" — channels.kinthai.email not configured`);
          return;
        }
        await registerSingleAgent(agentId, KINTHAI_URL, email, tokensFilePath, log);
      } catch (err) {
        log.warn(`[KK-W007] Auto-register error for "${agentId}": ${err.message}`);
      } finally {
        registeringAgents.delete(agentId);
      }
    });

    // Dynamic tool registration (v3.0.0).
    // Hook fetches manifest from backend on each agent run; factory reads
    // the per-agent cache and exposes typed tools to the LLM. New tools
    // ship via backend deploy; the plugin doesn't need a release.
    setupDynamicRegistry(api, {
      getApiForAgent: (agentId) => agentRegistry.get(agentId) || null,
      // ctx.agentId is the OpenClaw agent name (= agents.openclaw_agent_id
      // server-side). NOT the same as users.public_id. agentRegistry is
      // keyed by this value (plugin.js:163 state.agentId = openclawAgentId).
      getAgentId: (ctx) => ctx?.agentId || ctx?.agentAccountId || null,
      log,
    });
  },
});
