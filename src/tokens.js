/**
 * Multi-agent token management: load and watch .tokens.json.
 * 多 agent token 管理：加载和监听 .tokens.json。
 */

import { readFile } from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';

/**
 * Load agent tokens from .tokens.json, skipping metadata fields (prefixed with _).
 * 从 .tokens.json 加载 agent tokens，跳过元数据字段（以 _ 开头）。
 */
export async function loadTokens(tokensFilePath, log) {
  const tokens = {};
  try {
    const data = JSON.parse(await readFile(tokensFilePath, 'utf8'));
    for (const [label, val] of Object.entries(data)) {
      if (label.startsWith('_')) continue;
      if (typeof val === 'object' && val?.api_key) {
        tokens[label] = val.api_key;
      } else if (typeof val === 'string' && val) {
        tokens[label] = val;  // backward compat
      }
    }
  } catch {
    log?.error?.(
      `[KK-E001] .tokens.json not found or invalid — expected at ${tokensFilePath}. ` +
      'Create it with: {"main": "kk_your_api_key"}',
    );
    return null;
  }

  if (Object.keys(tokens).length === 0) {
    log?.error?.(
      '[KK-E001] .tokens.json is empty — add at least one token: {"main": "kk_your_api_key"}',
    );
    return null;
  }

  return tokens;
}

/**
 * Watch .tokens.json for new agents and hot-reload connections.
 * 监听 .tokens.json 变化，自动连接新 agent。
 *
 * Returns a stop function to unwatch.
 * 返回停止监听的函数。
 */
export function watchTokens(tokensFilePath, existingTokens, startAgentFn, log) {
  const knownTokens = new Set(Object.keys(existingTokens));

  watchFile(tokensFilePath, { interval: 10000 }, async () => {
    try {
      const newData = JSON.parse(await readFile(tokensFilePath, 'utf8'));
      for (const [label, val] of Object.entries(newData)) {
        if (label.startsWith('_')) continue;
        if (knownTokens.has(label)) continue;
        const token = typeof val === 'object' ? val?.api_key : (typeof val === 'string' ? val : null);
        if (!token) continue;
        knownTokens.add(label);
        log?.info?.(`[KK-I017] New agent token detected: "${label}" — starting connection`);
        await startAgentFn(token, label);
      }
    } catch (err) {
      log?.warn?.(`[KK-W005] Failed to reload .tokens.json: ${err.message}`);
    }
  });

  return () => unwatchFile(tokensFilePath);
}
