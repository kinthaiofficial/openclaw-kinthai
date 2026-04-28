/**
 * Runtime config patches applied on plugin register.
 * 插件注册时对 OpenClaw 配置做的运行时 patch。
 *
 * Why this exists: when a customer self-hosts OpenClaw with the strict
 * messaging tool profile (`tools.profile: "messaging"`), `kinthai_*` tools
 * registered by this plugin would be filtered out before the LLM sees them.
 * Ops can't ssh into every customer's machine to add `kinthai_*` to
 * `tools.alsoAllow`, and the npm `setup.mjs` only runs on the legacy npx
 * install path — ClawHub installs bypass it entirely. Patching the config
 * idempotently from `registerFull` covers every install path uniformly.
 */

export const KINTHAI_TOOL_PATTERN = 'kinthai_*';

/**
 * Compute the patched config that adds KINTHAI_TOOL_PATTERN to
 * `tools.alsoAllow` if it isn't already present. Returns `null` when no
 * change is needed (idempotent on repeat starts).
 *
 * Pure function — does not mutate the input. The caller is responsible
 * for persisting the result via `writeConfigFile`.
 */
export function computeAlsoAllowPatch(currentConfig, pattern = KINTHAI_TOOL_PATTERN) {
  const cur = currentConfig?.tools?.alsoAllow;
  if (Array.isArray(cur) && cur.includes(pattern)) return null;

  const next = JSON.parse(JSON.stringify(currentConfig || {}));
  next.tools = next.tools || {};
  const existing = Array.isArray(next.tools.alsoAllow) ? next.tools.alsoAllow : [];
  next.tools.alsoAllow = [...existing, pattern];
  return next;
}

/**
 * Surface a KK-E001 error when `channels.kinthai.email` is missing or empty.
 * email 缺失或为空时打 KK-E001 error log。
 *
 * Why this is needed: OpenClaw's gateway machinery calls
 * `plugin.config.isConfigured(account)` before invoking `startAccount`. If
 * the plugin returns false (which it does when email is missing), OpenClaw
 * silently sets internal `lastError` and skips `startAccount` entirely —
 * so the KK-E001 error log inside `startAccount` never fires. Calling this
 * from `registerFull` (which always runs) guarantees the log surfaces.
 * 此检查必须在 registerFull 里跑，不能在 startAccount 里——OpenClaw 在
 * isConfigured=false 时跳过 startAccount，不打任何日志，运维只能看到
 * "loaded but silent" 的现象，无从下手。
 */
export function checkEmailConfigured(api, log) {
  const email = api?.config?.channels?.kinthai?.email;
  if (typeof email === 'string' && email.trim()) return true;
  log?.error?.(
    '[KK-E001] channels.kinthai.email is not set — plugin will NOT start any agent. ' +
    'Run `openclaw config set channels.kinthai.email <addr>` or ' +
    '`openclaw setup --wizard` to enable.'
  );
  return false;
}

/**
 * Idempotently add `kinthai_*` to `config.tools.alsoAllow`. Best-effort —
 * never throws; logs warn on failure so the plugin still loads.
 * 幂等地把 `kinthai_*` 加进 `tools.alsoAllow`。失败只 warn 不抛，确保插件继续加载。
 *
 * Uses `api.runtime.config.writeConfigFile` — the SDK injects this onto the
 * api object at register time, so we don't need to ESM-import the openclaw
 * package (which fails: OpenClaw plugin install does not create a
 * `node_modules/openclaw` symlink in the plugin directory, and Node ESM
 * does not fall back to NODE_PATH or npm-global like CJS does).
 * 用 runtime 注入的 writeConfigFile，避开 ESM 模块解析——OpenClaw plugin
 * install 不在插件目录创建 node_modules/openclaw 符号链接，ESM 又不像 CJS
 * 会 fallback 到 NODE_PATH / npm global，dynamic import 必败。
 *
 * `writeFn` is injected for testing.
 */
export async function applyAlsoAllowPatch(api, log, writeFn) {
  try {
    const next = computeAlsoAllowPatch(api?.config);
    if (!next) return false; // already present
    const write = writeFn || api?.runtime?.config?.writeConfigFile;
    if (typeof write !== 'function') {
      throw new Error('api.runtime.config.writeConfigFile is not a function — SDK runtime not injected before registerFull');
    }
    await write(next);
    log?.info?.(`[KK-I031] Added "${KINTHAI_TOOL_PATTERN}" to tools.alsoAllow (first-time setup)`);
    return true;
  } catch (err) {
    log?.warn?.(
      `[KK-W009] alsoAllow patch failed: ${err.message} — agent may not see kinthai_* tools ` +
      `until they're added manually to tools.alsoAllow`
    );
    return false;
  }
}
