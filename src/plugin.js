/**
 * KinthAI channel plugin definition.
 * KinthAI 频道插件定义。
 */

import { createPluginRuntimeStore } from 'openclaw/plugin-sdk/runtime-store';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { KinthaiApi } from './api.js';
import { createFileHandler } from './files.js';
import { createMessageHandler } from './messages.js';
import { createConnection } from './connection.js';
import { loadTokens, watchTokens } from './tokens.js';
import { autoRegisterAgents } from './register.js';
import { kinthaiPluginBase } from './plugin-base.js';

const __dirname = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const runtimeStore = createPluginRuntimeStore('kinthai: runtime not initialized');
const { getRuntime, setRuntime } = runtimeStore;

const kinthaiPlugin = {
  ...kinthaiPluginBase,
  setup: {},
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;

      // [KK-E001] url is the only required config field
      // [KK-E001] url 是唯一必需的配置字段
      if (!account.url) {
        ctx.log?.error?.(
          '[KK-E001] Config invalid: url missing — channel will not start. ' +
          'Check channels.kinthai in openclaw.json.',
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

      // Read plugin version from package.json
      // 从 package.json 读取插件版本
      let pluginVersion = '0.0.0';
      try {
        const { readFile } = await import('node:fs/promises');
        const pkg = JSON.parse(await readFile(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
        pluginVersion = pkg.version || '0.0.0';
      } catch {
        ctx.log?.warn?.('[KK-W004] Could not read package.json for version');
      }

      const kithApiUrl = account.url.replace(/\/$/, '');
      const wsUrl = account.wsUrl || account.url.replace(/^http/, 'ws');
      const tokensFilePath = path.join(PLUGIN_ROOT, '.tokens.json');

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

        const kithUserId = selfUserId || account.kinthaiUserId || 'kinthai';

        ctx.log?.info?.(
          `[KK-I002] startAgent "${label}" — url=${kithApiUrl} wsUrl=${wsUrl} ` +
          `kithUserId=${kithUserId} selfUserId=${selfUserId} agentId=${openclawAgentId} ` +
          `channelRuntime=${ctx.channelRuntime ? 'available' : 'NOT available (KK-E004 will fire)'}`,
        );

        const state = {
          kithUserId,
          selfUserId,
          agentId: openclawAgentId,
          wsUrl,
          pluginVersion,
          ws: null,
          connectedAt: null,
          lastPong: null,
        };

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

export { kinthaiPlugin, setRuntime, getRuntime };
