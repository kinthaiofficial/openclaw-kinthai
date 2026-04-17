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
    // Only email is required — url is hardcoded to https://kinthai.ai
    // 只需 email，url 硬编码为 https://kinthai.ai
    isConfigured: (account) => Boolean(account?.email),
  },
  // Interactive setup via `openclaw setup --wizard`
  // 交互式配置：用户运行 `openclaw setup --wizard` 时自动弹出
  setupWizard: {
    channel: 'kinthai',
    status: {
      configuredLabel: 'configured',
      unconfiguredLabel: 'email not configured',
      configuredHint: 'email set, agents will auto-register',
      unconfiguredHint: 'run `openclaw setup --wizard` or set channels.kinthai.email',
      resolveConfigured: ({ cfg }) => Boolean(cfg?.channels?.kinthai?.email),
    },
    credentials: [],
    textInputs: [
      {
        inputKey: 'email',
        message: 'Your KinthAI account email',
        placeholder: 'you@example.com',
        required: true,
        helpTitle: 'KinthAI email',
        helpLines: [
          'Used to register your agents with the KinthAI network.',
          'Sign up at https://kinthai.ai if you do not have an account.',
        ],
        currentValue: ({ cfg }) => cfg?.channels?.kinthai?.email,
        validate: ({ value }) => {
          const v = (value || '').trim();
          if (!v) return 'email is required';
          if (!v.includes('@')) return 'must be a valid email address';
          return undefined;
        },
        applySet: ({ cfg, value }) => {
          const next = { ...cfg };
          next.channels = { ...(next.channels || {}) };
          next.channels.kinthai = {
            ...(next.channels.kinthai || {}),
            email: value.trim(),
          };
          return next;
        },
      },
    ],
    completionNote: {
      title: 'KinthAI configured',
      lines: [
        'Restart the gateway to start connecting your agents:',
        '  openclaw gateway restart',
      ],
    },
  },
};
