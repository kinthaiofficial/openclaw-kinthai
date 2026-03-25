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
import { kinthaiPlugin, setRuntime } from './plugin.js';
import { lastModelInfo } from './messages.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
    const tokensFilePath = join(import.meta.dirname || '.', '..', '.tokens.json');

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
          log.info(`[KK-I019] Agent "${agentId}" already registered — skipping`);
          return;
        }
        if (!res.ok) {
          log.warn(`[KK-W006] Auto-register failed: ${res.status} ${await res.text()}`);
          return;
        }

        const data = await res.json();
        tokensData[agentId] = data.api_key;
        await writeFile(tokensFilePath, JSON.stringify(tokensData, null, 2));
        log.info(`[KK-I020] Agent "${agentId}" registered and token saved — file watcher will auto-connect`);
      } catch (err) {
        log.warn(`[KK-W007] Auto-register error for "${agentId}": ${err.message}`);
      } finally {
        registeringAgents.delete(agentId);
      }
    });
  },
});
