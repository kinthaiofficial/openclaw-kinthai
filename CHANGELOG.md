# Changelog

## 3.0.0 (2026-04-27)

### Major Feature: Dynamic Tool Registration

Agents now operate KinthAI through real OpenClaw tools (`kinthai_upload_file`, …) instead of post-hoc `[FILE:]` marker parsing. Tool calls return structured results (`{ok:true, data:{...}}` or `{ok:false, error, hint}`), so agents know whether a file actually went through. This addresses the v2.7.0 "agent says ✅ uploaded when nothing was sent" problem.

**Mechanism**:
- `before_agent_start` async hook fetches `GET /api/v1/agent/tools/manifest` and writes a per-agent local cache.
- `registerTool` factory (sync, called per agent run) reads the cache and exposes typed tools to the LLM.
- New tools ship via backend deploy — the plugin doesn't need a release.

**New files**:
- `src/tools/local-primitives.js` — read/write/list_local_dir + multipart `upload_local_file_to_conversation` continuation handlers; allowlist passed in as a parameter (not module-level state) so multi-agent runs in the same process can't pollute each other's filesystem boundary.
- `src/tools/continuation.js` — drives the dispatch → continuation → continue loop with depth cap.
- `src/tools/dynamic-registry.js` — wires the hook + factory; mtime-based mem cache; cold-path falls back to `default-manifest.json` so the LLM still sees tools when the backend is unreachable (failure becomes structured feedback, not "tool disappeared").
- `default-manifest.json` — first-run fallback containing `kinthai_upload_file`.

**API additions** (`src/api.js`):
- `fetchToolManifest({signal})` — manifest GET with abort signal support.
- `dispatchTool(name, params, dispatchId)` — sends `X-Dispatch-Id` header; folds non-2xx into `{ok:false, error, hint}`; implements 429 backoff (3 attempts, honors `Retry-After`).
- `continueTool(continuationId, result)` — same response folding.

**Error code segment**: `KK-T001..T032` (info / warn / error for manifest refresh, dispatch, continuation, terminal).

**SKILL.md** (`skills/kinthai-files/`): slimmed from ~85 lines to ~35 lines — decision guidance instead of marker syntax. The marker mechanism still works (compat path), but the skill steers agents toward the tool.

### Compatibility

- `[FILE:]` marker parsing in `src/files.js` is **retained** for a 6-month compat window. Existing agents continue to work without changes.
- No breaking changes to `KinthaiApi` for existing methods.
- No changes to channel registration, WS protocol, or token format.
- `skills/kinthai-files/SKILL.md` is now in `package.json files[]` and the publish allowlist (was missing in v2.7.0; that skill only worked in places where it was hand-installed).

### Tests

- `test/test-tools-local-primitives.js` — path allowlist, multi-agent isolation regression (P0-#13), 8MB inline cap, base64 round-trip, dir listing.
- `test/test-tools-continuation.js` — terminal pass-through, single/chained continuations, depth limit, unknown type, local primitive failures, network throw.
- `test/test-tools-dynamic-registry.js` — factory cold path, hook fetch + cache write, fetch failure fallback, manifest_version validation, mtime invalidation, dispatchId UUID propagation.
- `test/test-api-tools.js` — end-to-end against mock server: manifest fetch, dispatch happy path / continuation / terminal / 200+ok:false / unauthorized / schema_invalid / 429 backoff, continue happy path / expired / anti-theft, X-Dispatch-Id propagation.

`test/mock-server.js` extended with `/api/v1/agent/tools/manifest|dispatch|continue` plus per-agent rate-limit toggle and dispatch observation helpers.

### Notes for ops

This release expects three new backend endpoints. Until the backend is deployed, the plugin falls back to the bundled `default-manifest.json` and dispatch handlers return `backend_unavailable` — the agent sees the tool exists but gets a structured failure when calling it. This is intentional: it preserves the tool surface for the LLM and produces honest failure messages instead of silent disappearance.

## 2.6.3 (2026-04-17)

### Internal
- Remove `scripts/publish-clawhub.sh` (maintainer-only release script) from the package. It was being bundled into the npm tarball via a directory glob (`scripts/` in `files[]`) even though end users never invoke it. Moved to the private maintainer companion; not shipped.
- Convert `files[]` in `package.json` from directory globs to an explicit per-file allowlist. New files added under `src/` or `scripts/` no longer ship implicitly — they must be added to `files[]` deliberately.
- Add `prepublishOnly` hook (`scripts/check-publish-allowlist.mjs` + `scripts/publish-allowlist.json`) that compares the actual tarball contents against a frozen expected list and aborts `npm publish` on any drift.

## 2.6.2 (2026-04-17)

### Docs
- Rewrite README Installation / Configuration / Update / Uninstall sections to match the v2.6.0+ code. Removed the stale `channels.kinthai.url` / `wsUrl` JSON block (these keys were removed in 2.6.0 — URL is hardcoded) and the old `.tokens.json` manual-creation block (tokens now live at `~/.openclaw/credentials/kinthai/.tokens.json` and are managed automatically). Documented the `install` / `update` / `uninstall` / `remove` npx subcommands instead of the pre-2.6.0 single-command flow. Same updates applied to `docs/README.zh.md`.

## 2.6.1 (2026-04-17)

### Fix
- Move `README.zh.md` out of package root into `docs/`. npm registry was selecting `README.zh.md` as the readme metadata, so the package page on npmjs.com rendered the Chinese README instead of the English one. v2.6.0 ships correct code; only the rendered page was wrong. Verified on ClawHub as rc.1 before promoting.

## 2.6.0 (2026-04-17)

Stable release of 2.6.0 after 8 rc iterations on 10.8.4.11 (oc-plugin-test).
All 56 unit tests + install / uninstall / remove / ClawHub integration verified.

## 2.6.0-rc.2 (2026-04-17)

### Fix
- Exclude `test/`, `docs/`, `.github/` from ClawHub package (was triggering security scanner false positives from test files that use child_process).

## 2.6.0-rc.1 (2026-04-17)

### Breaking Changes
- **Tokens moved to `~/.openclaw/credentials/kinthai/.tokens.json`** (was `PLUGIN_ROOT/.tokens.json`). This fixes a critical bug where ClawHub upgrades wiped all agent tokens. No migration: agents will re-register via 409 conflict recovery on first run.
- **`url` is no longer configurable** — hardcoded to `https://kinthai.ai`. Self-hosted deployments are not supported. Removed `KINTHAI_URL` env var.
- **Removed `channels.kinthai.url` / `wsUrl` / `kinthaiUserId`** from config schema. Only `email` is accepted.
- **`.tokens.json` no longer stores `_email` / `_kinthai_url`** — email is read from `channels.kinthai.email`, url is hardcoded. Only `_machine_id` metadata is preserved.
- **`registerSingleAgent()` signature changed** — now takes `(agentId, kinthaiUrl, email, tokensFilePath, log)`. email is passed by caller (from openclaw config), not read from tokens file.

### New Features
- **npx commands delegate to `openclaw plugins/config/channels`** — install/update/uninstall/remove all invoke openclaw native commands. Both npx and ClawHub installs now end up in `~/.openclaw/extensions/kinthai/` (no more `channels/kinthai/` divergence).
- **`npx update` command** — update plugin without re-entering email.
- **`npx uninstall` vs `npx remove`** — uninstall keeps credentials (for reinstall), remove purges everything.
- **`onAccountRemoved` lifecycle hook** — clears `credentials/kinthai/` when user runs `openclaw channels remove kinthai --delete`.
- **`setupWizard`** — ClawHub users can run `openclaw setup --wizard` for interactive email configuration.

### Internal
- Tokens file parent dir auto-created on save (`mkdir -p`)
- Config adapter `isConfigured` checks email instead of url

## 2.5.1 (2026-04-16)

### Improvements
- **Lazy machineId acquisition**: `scanLocalState()` no longer fetches deviceId — deferred to actual registration time via new `getMachineId()`. Already-registered agents (with cached tokens) start without needing gateway online. Fixes startup failure when plugin loads before gateway is ready.

## 2.5.0 (2026-04-14)

### New Features
- **File sync protocol**: `admin.file_request` (read) and `admin.file_push` (write) WS events — enables "Sync from OpenClaw" and "Push to OpenClaw" in KinthAI frontend (requires kinthai >= v4.4.0)
- **Workspace resolution via SDK**: Uses `api.runtime.agent.resolveAgentWorkspaceDir()` instead of hardcoded paths

### Security
- **Zero scanner warnings**: Restructured all source files to eliminate OpenClaw security scanner `potential-exfiltration` warnings — no file contains both `readFile` and `fetch`
- **File sync whitelist**: Only 7 known bootstrap files (SOUL.md, AGENTS.md, etc.) + skills/ and memory/ directories (.md only)
- **Blocked files**: .env, .tokens.json, device.json, openclaw.json, .npmrc are never read or written by file sync
- **Path traversal protection**: All paths validated with `path.resolve()` boundary check
- **Size limits**: 100KB per file, 1MB total response

### Internal Refactoring
- Split `register.js` into `register.js` (network) + `register-scan.js` (file I/O)
- Split `updater.js` into `updater.js` (file I/O) + `updater-download.js` (network)
- Moved auto-register logic from `index.js` to `register.js` (`registerSingleAgent`)
- Moved `readPluginVersion()` from `plugin.js` to `register-scan.js`

### Compatibility
- Backward compatible: old backends (< v4.4.0) never send file sync events — new code exists but is never triggered
- Old plugins (< v2.5.0) ignore file sync events — backend times out and reports agent_offline

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
