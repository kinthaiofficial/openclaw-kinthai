/**
 * KinthAI channel plugin definition.
 * KinthAI 频道插件定义。
 */

import { createPluginRuntimeStore } from 'openclaw/plugin-sdk/runtime-store';
import { resolveOAuthDir } from 'openclaw/plugin-sdk/state-paths';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { KinthaiApi } from './api.js';
import { createFileHandler } from './files.js';
import { createMessageHandler } from './messages.js';
import { createConnection } from './connection.js';
import { loadTokens, watchTokens } from './tokens.js';
import { autoRegisterAgents } from './register.js';
import { readPluginVersion } from './register-scan.js';
import { kinthaiPluginBase } from './plugin-base.js';

const __dirname = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');

// Hardcoded KinthAI endpoints — self-hosted deployments are not supported.
// 硬编码 KinthAI 端点 — 不支持自部署服务端。
const KINTHAI_URL = 'https://kinthai.ai';
const KINTHAI_WS_URL = 'wss://kinthai.ai';

// Tokens stored in openclaw's credentials dir — survives plugin upgrades.
// tokens 存在 openclaw 的 credentials 目录下 — 插件升级不会丢失。
// Path: ~/.openclaw/credentials/kinthai/.tokens.json
export const TOKENS_FILE_PATH = path.join(resolveOAuthDir(), 'kinthai', '.tokens.json');

const runtimeStore = createPluginRuntimeStore('kinthai: runtime not initialized');
const { getRuntime, setRuntime } = runtimeStore;

// Agent API instances + identity — shared with before_prompt_build hook
// agentId → { api, selfPublicId, selfUserId }
export const agentRegistry = new Map();

const kinthaiPlugin = {
  ...kinthaiPluginBase,
  setup: {},
  lifecycle: {
    // Clean up credentials/kinthai/ when user removes the account.
    // Triggered by: openclaw channels remove kinthai --delete
    // 用户删除账号时清理 credentials/kinthai/
    // 触发：openclaw channels remove kinthai --delete
    onAccountRemoved: async ({ accountId }) => {
      try {
        const { rm } = await import('node:fs/promises');
        const credDir = path.dirname(TOKENS_FILE_PATH);
        await rm(credDir, { recursive: true, force: true });
        console.log(`[KK-I030] Cleaned credentials for account "${accountId}" at ${credDir}`);
      } catch (err) {
        console.warn(`[KK-W008] Failed to clean credentials: ${err.message}`);
      }
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;

      // [KK-E001] email is the only required config field
      // [KK-E001] email 是唯一必需的配置字段
      if (!account.email) {
        ctx.log?.error?.(
          '[KK-E001] Config invalid: email missing — agents cannot register. ' +
          'Run `openclaw config set channels.kinthai.email your@email.com` or ' +
          '`openclaw setup --wizard` to configure.',
        );
        return;
      }

      // Disabled mode: skip agent connections, agents will appear offline (red)
      // 禁用模式：跳过 agent 连接，agent 将显示为离线（红点）
      if (account.enabled === false) {
        ctx.log?.info?.('[KK-I022] KinthAI channel disabled — agents will not connect');
        // Wait for abort signal (keep plugin alive for potential re-enable)
        await new Promise((resolve) => {
          ctx.abortSignal.addEventListener('abort', resolve);
        });
        return;
      }

      // Read plugin version from package.json (via register-scan.js)
      // 从 package.json 读取插件版本（通过 register-scan.js）
      const pluginVersion = await readPluginVersion(PLUGIN_ROOT);

      const kithApiUrl = KINTHAI_URL;
      const wsUrl = KINTHAI_WS_URL;
      const tokensFilePath = TOKENS_FILE_PATH;

      // Auto-register agents if email is configured
      // 如果配置了 email，自动注册所有 agent
      let tokens = null;
      if (account.email) {
        tokens = await autoRegisterAgents(kithApiUrl, account.email, tokensFilePath, ctx.log);
      }

      // Load tokens (auto-register may have created/updated .tokens.json)
      // 加载 tokens（自动注册可能已创建/更新 .tokens.json）
      if (!tokens) {
        tokens = await loadTokens(tokensFilePath, ctx.log);
      }
      if (!tokens || Object.keys(tokens).length === 0) return;

      const allConnections = [];

      // Start one agent connection
      // 启动单个 agent 连接
      async function startAgent(token, label) {
        const api = new KinthaiApi(kithApiUrl, token, ctx.log);

        let selfUserId = null;
        let openclawAgentId = label; // fallback to token label
        try {
          const meData = await api.getMe();
          selfUserId = meData?.user_id || null;
          openclawAgentId = meData?.openclaw_agent_id || label;
        } catch (err) {
          ctx.log?.warn?.(`[KK-W] ${label} /users/me failed: ${err.message}`);
          return;
        }

        const kithUserId = selfUserId || 'kinthai';

        ctx.log?.info?.(
          `[KK-I002] startAgent "${label}" — url=${kithApiUrl} wsUrl=${wsUrl} ` +
          `kithUserId=${kithUserId} selfUserId=${selfUserId} agentId=${openclawAgentId} ` +
          `channelRuntime=${ctx.channelRuntime ? 'available' : 'NOT available (KK-E004 will fire)'}`,
        );

        // Resolve agent workspace directory via SDK API (for file-sync)
        // 通过 SDK API 解析 agent 工作区目录（用于文件同步）
        let workspaceDir = null;
        try {
          const runtime = getRuntime();
          if (runtime?.agent?.resolveAgentWorkspaceDir) {
            const cfg = runtime.config?.loadConfig
              ? await runtime.config.loadConfig()
              : null;
            if (cfg) {
              workspaceDir = runtime.agent.resolveAgentWorkspaceDir(cfg);
              ctx.log?.info?.(`[KK-I028] Workspace dir resolved: ${workspaceDir}`);
            }
          }
        } catch {
          ctx.log?.debug?.(`[KK-I028] Could not resolve workspace dir for ${openclawAgentId} — file-sync will be unavailable`);
        }

        const state = {
          kithUserId,
          selfUserId,
          agentId: openclawAgentId,
          wsUrl,
          pluginVersion,
          workspaceDir,
          ws: null,
          connectedAt: null,
          lastPong: null,
        };

        // Register for before_prompt_build hook
        agentRegistry.set(state.agentId, { api, selfPublicId: selfUserId, selfUserId: kithUserId });

        const fileHandler = createFileHandler(api, ctx.log);
        const messageHandler = createMessageHandler(api, fileHandler, state, ctx);
        const connection = createConnection(api, state, messageHandler, ctx);

        connection.start();
        allConnections.push(connection);
      }

      // Start all agents
      // 启动所有 agent
      const entries = Object.entries(tokens);
      ctx.log?.info?.(`[KK-I001] KinthAI channel plugin v${pluginVersion} starting — ${entries.length} agent(s)`);
      for (const [label, token] of entries) {
        await startAgent(token, label);
      }

      // Watch .tokens.json for new agents (hot-reload)
      // 监听 .tokens.json 变化，热加载新 agent
      const stopWatching = watchTokens(tokensFilePath, tokens, startAgent, ctx.log);

      // Periodic scan for new agents (every 30s)
      // 定时扫描新 agent（每 30 秒）
      const scanTimer = account.email ? setInterval(async () => {
        try {
          const newTokens = await autoRegisterAgents(kithApiUrl, account.email, tokensFilePath, ctx.log);
          if (!newTokens) return;
          for (const [label, token] of Object.entries(newTokens)) {
            if (!tokens[label]) {
              tokens[label] = token;
              ctx.log?.info?.(`[KK-I017] New agent registered by scan: "${label}" — starting connection`);
              await startAgent(token, label);
            }
          }
        } catch (err) {
          ctx.log?.debug?.(`[KK-W] Agent scan error: ${err.message}`);
        }
      }, 30_000) : null;

      // Wait for abort signal
      // 等待停止信号
      await new Promise((resolve) => {
        ctx.abortSignal.addEventListener('abort', () => {
          stopWatching();
          if (scanTimer) clearInterval(scanTimer);
          for (const conn of allConnections) conn.stop();
          resolve();
        });
      });
    },
  },
};

export { kinthaiPlugin, setRuntime, getRuntime, KINTHAI_URL };
