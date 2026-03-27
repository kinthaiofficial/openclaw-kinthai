/**
 * Lightweight setup entry — loaded when KinthAI channel is disabled or unconfigured.
 * 轻量级设置入口 — 频道禁用或未配置时加载。
 *
 * Only imports plugin-base.js (pure config, no side effects).
 * Does NOT import: WebSocket, fs, crypto, register, files, connection, messages.
 * 仅导入 plugin-base.js（纯配置，无副作用）。
 * 不导入：WebSocket、fs、crypto、register、files、connection、messages。
 */

import { defineSetupPluginEntry } from 'openclaw/plugin-sdk/core';
import { kinthaiPluginBase } from './src/plugin-base.js';

export { kinthaiPluginBase };

export default defineSetupPluginEntry(kinthaiPluginBase);
