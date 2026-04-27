/**
 * Dynamic tool registration.
 *
 * Wires:
 *   1. before_agent_start hook — async, fetches manifest, writes per-agent cache
 *   2. registerTool factory   — sync, reads cache, returns AnyAgentTool[]
 *
 * Same agent run guarantees:
 *   • before_agent_start is awaited before the factory fires (OpenClaw
 *     `pi-embedded-runner/run.ts:361` → `attempt.ts:678`)
 *   • factory output drives the LLM tool list for that run
 *
 * Cold path / hook failure / API instance unavailable → factory still
 * returns the cached or default-manifest tools (their handlers will return
 * `{ok:false, error:'backend_unavailable'}` when invoked). This keeps the
 * tool surface visible to the LLM even when the backend is down — failure
 * becomes structured feedback instead of "tool disappeared".
 */

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runContinuationLoop } from './continuation.js';
import { buildAllowlist } from './local-primitives.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_MANIFEST_PATH = path.join(PLUGIN_ROOT, 'default-manifest.json');

const MANIFEST_FETCH_TIMEOUT_MS = 2000;

let DEFAULT_MANIFEST = null;
function getDefaultManifest() {
  if (!DEFAULT_MANIFEST) {
    DEFAULT_MANIFEST = JSON.parse(fs.readFileSync(DEFAULT_MANIFEST_PATH, 'utf8'));
  }
  return DEFAULT_MANIFEST;
}

function safeAgentId(agentId) {
  return String(agentId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function cacheDir() {
  const home = process.env.HOME || '/tmp';
  return path.join(home, '.openclaw', 'extensions', 'kinthai', 'cache');
}

function cachePath(agentId) {
  return path.join(cacheDir(), `manifest-${safeAgentId(agentId)}.json`);
}

// In-memory cache: agentId → { mtimeMs, manifest }
const memCache = new Map();

function readCachedManifest(agentId, log) {
  if (!agentId) return getDefaultManifest();
  const p = cachePath(agentId);
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    log?.debug?.(`[KK-T021] no cached manifest for ${agentId}, using default`);
    return getDefaultManifest();
  }
  const cached = memCache.get(agentId);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.manifest;
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (m.manifest_version !== 1 || !Array.isArray(m.tools)) {
      log?.warn?.(`[KK-T020] cached manifest invalid (version=${m.manifest_version}), using default`);
      return getDefaultManifest();
    }
    memCache.set(agentId, { mtimeMs: stat.mtimeMs, manifest: m });
    return m;
  } catch (err) {
    log?.warn?.(`[KK-T022] cached manifest parse failed: ${err.message}, using default`);
    return getDefaultManifest();
  }
}

async function refreshManifest(api, agentId, log) {
  if (!agentId || !api?.fetchToolManifest) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MANIFEST_FETCH_TIMEOUT_MS);
  try {
    const m = await api.fetchToolManifest({ signal: ctrl.signal });
    if (!m || m.manifest_version !== 1 || !Array.isArray(m.tools)) {
      log?.warn?.(`[KK-T022] fetched manifest invalid, keeping stale cache`);
      return;
    }
    await fsp.mkdir(cacheDir(), { recursive: true });
    const p = cachePath(agentId);
    const tmp = `${p}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(m));
    await fsp.rename(tmp, p);
    log?.info?.(`[KK-T001] manifest refreshed agentId=${agentId} tools=${m.tools.length}`);
  } catch (err) {
    log?.warn?.(`[KK-T023] manifest refresh failed agentId=${agentId}: ${err.message} — using stale cache`);
  } finally {
    clearTimeout(timer);
  }
}

function makeHandler({ tool, agentId, getApiForAgent, ctx, log }) {
  const allowedPrefixes = buildAllowlist({ workspaceDir: ctx.workspaceDir });
  return async (params) => {
    const dispatchId = randomUUID();
    log?.info?.(`[KK-T002] dispatch tool=${tool.name} agentId=${agentId} dispatchId=${dispatchId}`);

    const entry = agentId ? getApiForAgent(agentId) : null;
    const api = entry?.api;
    if (!api) {
      log?.warn?.(`[KK-T030] dispatch ${tool.name} skipped — no active KinthaiApi for agentId=${agentId}`);
      return {
        ok: false,
        error: 'backend_unavailable',
        hint: 'Plugin has no active KinthAI session for this agent yet.',
      };
    }

    let resp;
    try {
      resp = await api.dispatchTool(tool.name, params, dispatchId);
    } catch (err) {
      log?.error?.(`[KK-T030] dispatch ${tool.name} failed: ${err.message}`);
      return {
        ok: false,
        error: err.code || 'backend_unavailable',
        hint: err.message,
      };
    }

    return runContinuationLoop(api, resp, { allowedPrefixes, log });
  };
}

/**
 * Wire the dynamic registry into a plugin's `registerFull(api)` body.
 *
 * @param {object} pluginApi - OpenClawPluginApi
 * @param {object} opts
 * @param {(agentId: string) => {api: object} | null | undefined} opts.getApiForAgent
 * @param {(ctx: object) => string | null | undefined} opts.getAgentId
 *        Extract the OpenClaw agent id (= `agents.openclaw_agent_id` server-side)
 *        from the factory or hook ctx. **Not** the same as KinthAI users.public_id —
 *        plugin-side caches and registries are keyed by OpenClaw agent name.
 * @param {object} [opts.log]
 */
export function setupDynamicRegistry(pluginApi, { getApiForAgent, getAgentId, log }) {
  if (!pluginApi || typeof pluginApi.on !== 'function' || typeof pluginApi.registerTool !== 'function') {
    throw new Error('setupDynamicRegistry: pluginApi must expose .on() and .registerTool()');
  }
  if (typeof getApiForAgent !== 'function' || typeof getAgentId !== 'function') {
    throw new Error('setupDynamicRegistry: getApiForAgent and getAgentId are required');
  }

  pluginApi.on('before_agent_start', async (event, ctx) => {
    try {
      const agentId = getAgentId(ctx);
      if (!agentId) return;
      const entry = getApiForAgent(agentId);
      if (!entry?.api) return;
      await refreshManifest(entry.api, agentId, log);
    } catch (err) {
      log?.warn?.(`[KK-T024] before_agent_start manifest refresh threw: ${err.message}`);
    }
  });

  pluginApi.registerTool((ctx) => {
    const agentId = getAgentId(ctx) || null;
    const manifest = readCachedManifest(agentId, log);
    return manifest.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      handler: makeHandler({ tool, agentId, getApiForAgent, ctx, log }),
    }));
  });
}

// Test surface — not part of the public plugin API.
export const __testing = {
  cachePath,
  cacheDir,
  readCachedManifest,
  refreshManifest,
  resetMemCache: () => memCache.clear(),
  getDefaultManifest,
  makeHandler,
  MANIFEST_FETCH_TIMEOUT_MS,
};
