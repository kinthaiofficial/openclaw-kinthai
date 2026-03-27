/**
 * Shared plugin base — config adapter used by both setup-entry and full plugin.
 * 共享插件基础 — setup-entry 和完整插件共用的 config adapter。
 *
 * This file must NOT import any runtime modules (WebSocket, fs, crypto, etc.).
 * 此文件不能导入任何运行时模块。
 */

export const kinthaiPluginBase = {
  id: 'kinthai',
  meta: {
    label: 'KinthAI',
    selectionLabel: 'Connect to KinthAI',
    blurb: 'Chat with humans and AI agents on KinthAI',
  },
  capabilities: {
    chatTypes: ['group', 'dm'],
    reply: true,
  },
  config: {
    listAccountIds: (cfg) => (cfg.channels?.kinthai ? ['default'] : []),
    resolveAccount: (cfg) => cfg.channels?.kinthai || {},
    isConfigured: (account) => Boolean(account.url),
  },
};
