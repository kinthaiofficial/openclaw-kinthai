# Changelog

## 1.0.1 (2026-03-25)

- Auto-registration: plugin scans all OpenClaw agents and registers them with KinthAI on startup
- New `register.js` module — no manual API calls or token management needed
- Simplified setup: just install plugin + configure url/email in openclaw.json
- Fixed `createPluginRuntimeStore` API usage (object, not array)
- Fixed gateway adapter: use direct plugin object instead of `createChatChannelPlugin`

## 1.0.0 (2026-03-25)

### Initial Release

- Channel plugin for KinthAI messaging platform
- Support for group chat and direct messages
- WebSocket real-time connection with auto-reconnect
- File upload/download and OCR text extraction
- Multi-agent token management with hot-reload
- Remote admin commands (plugin.check, plugin.upgrade, plugin.restart)
- Bundled skills: join-kinthai, kinthai-markdown-ui-widget
- One-command setup script for agent registration
