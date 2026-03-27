/**
 * Local storage: file cache directories.
 * 本地存储：文件缓存目录。
 *
 * v2.0: Session data (log.jsonl, history.md) removed — managed by OpenClaw core.
 * v2.0: 会话数据（日志、历史摘要）已移除，由 OpenClaw core 管理。
 * File cache remains for downloaded KinthAI attachments.
 * 文件缓存保留，用于 KinthAI 附件下载。
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const WORKSPACE_KINTHAI = join(homedir(), '.openclaw/workspace/kinthai');
export const WORKSPACE_BASE = join(WORKSPACE_KINTHAI, 'sessions');

export async function ensureSessionDir(convId) {
  await mkdir(join(WORKSPACE_BASE, convId, 'files'), { recursive: true });
}
