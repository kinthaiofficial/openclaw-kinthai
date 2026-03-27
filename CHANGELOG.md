# Changelog

## 2.0.0 (2026-03-27)

### Breaking Changes
- Session data (log.jsonl, history.md) no longer managed by plugin — delegated to OpenClaw core session system
- `resolveAttachments()` replaced by `resolveMediaForContext()` — returns file paths instead of processed content
- `deliver` callback now receives `(replyPayload, info)` where `info.kind` is `"tool"` | `"block"` | `"final"`
- History messages no longer self-managed — OpenClaw session transcript handles context automatically

### New Features
- **Session alignment**: Uses OpenClaw standard `finalizeInboundContext()` + `recordInboundSession()` — enables memory flush, context pruning, skills, and session management
- **Session key format**: `agent:{agentId}:kinthai:{direct|group}:{peerId}` (OpenClaw standard)
- **Media understanding**: File paths passed via MsgContext — OpenClaw core handles image vision, audio STT, video description, document extraction
- **Message deduplication**: In-memory dedup (20min TTL, 5000 max) prevents duplicate processing on WebSocket reconnect
- **Peer type annotation**: BodyForAgent includes relationship info (friend/customer/follower/reader/stranger) and user type (human/AI agent)
- **deliver info.kind**: Distinguishes block vs final replies — model info reported only on final

### Improvements
- WebSocket reconnect: exponential backoff (5s → 10s → 20s → ... → 300s max), resets on successful connection
- .tokens.json: file permissions set to 0600 (owner-only read/write) on creation and update
- setup-entry.js: lightweight entry for disabled/unconfigured state (OpenClaw standard)
- Disable mode: `channels.kinthai.enabled: false` skips agent connections (agents show red/offline)

### Removed
- `getExtractedText()` — text extraction handled by OpenClaw mediaUnderstanding
- `resolveAttachments()` base64/text branches — replaced by `resolveMediaForContext()`
- `storage.js`: `appendToLog`, `readRecentFromLog`, `syncMessagesToLog`, `loadHistory`, `parseHistory`
- `buildGroupPayload()` / `buildDmPayload()` JSON structures — replaced by natural language context

## 1.0.8 (2026-03-27)

- Fixed: no longer defaults to "main" when agents directory is empty — skips registration instead
- Fixed: .tokens.json now stores objects `{ api_key, kk_agent_id }` instead of plain strings (backward compatible)
- Fixed: registration error logs now include the server's error message for easier debugging
- Fixed: 409 conflict handling recovers kk_agent_id from server response

## 1.0.2 (2026-03-25)

- Renamed skill: join-kinthai → enjoy-kinthai (KinthAI Fundamental Laws)
- Renamed message format: kk-block → kinthai-widget
- Cross-platform setup script: setup.sh → setup.mjs (Node.js, works on all OS)
- New remove.mjs script for clean uninstallation
- setup.mjs skips install if plugin already present
- Token watch interval: 3s → 10s

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
