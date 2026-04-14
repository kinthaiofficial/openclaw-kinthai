/**
 * File sync protocol: admin.file_request (read) + admin.file_push (write).
 * 文件同步协议：admin.file_request（读取）+ admin.file_push（写入）。
 *
 * This module only does local file I/O — no network calls.
 * 此模块只做本地文件读写 — 不含网络请求。
 *
 * Security design:
 *   - Whitelist-only: only known OpenClaw bootstrap files are readable/writable
 *   - Path traversal protection: resolved paths must stay within workspace
 *   - Blocked files: .env, .tokens.json, device.json, etc. are never accessed
 *   - Size limits: 100KB per file, 1MB total response
 *   - Only .md files in allowed directories
 *
 * 安全设计：
 *   - 白名单：只读写已知的 OpenClaw bootstrap 文件
 *   - 路径遍历防护：解析后的路径必须在工作区内
 *   - 黑名单文件：.env、.tokens.json、device.json 等绝不访问
 *   - 大小限制：单文件 100KB，总响应 1MB
 *   - 只允许 .md 文件
 */

import crypto from 'node:crypto';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_SIZE = 100 * 1024;       // 100KB per file
const MAX_TOTAL_SIZE = 1 * 1024 * 1024; // 1MB total response

// Allowed root files (read + write)
const ALLOWED_ROOT_FILES = new Set([
  'SOUL.md',
  'AGENTS.md',
  'IDENTITY.md',
  'HEARTBEAT.md',
  'TOOLS.md',
  'BOOTSTRAP.md',
  'MEMORY.md',
]);

// Allowed directories for recursive .md read/write
const ALLOWED_DIRS = new Set(['skills', 'memory']);

// Never read or write these files, even if in an allowed directory
const BLOCKED_FILES = new Set([
  '.env',
  '.tokens.json',
  'device.json',
  'openclaw.json',
  'openclaw.plugin.json',
  '.npmrc',
]);

/**
 * Handle admin.file_request — read whitelisted files from agent workspace.
 * 处理 admin.file_request — 从 agent 工作区读取白名单文件。
 *
 * @param {object} data - Parsed WS event data
 * @param {string} workspaceDir - Agent workspace directory (from SDK)
 * @param {WebSocket} ws - WebSocket connection
 * @param {object} log - Logger
 */
export async function handleFileRequest(data, workspaceDir, ws, log) {
  const { request_id, files = [], include_dirs = [] } = data;
  const result = { event: 'admin.file_response', request_id, files: [], errors: [] };
  let totalSize = 0;

  log?.info?.(`[KK-SYNC] file_request received — request_id=${request_id} files=${files.length} dirs=${include_dirs.length}`);

  // 1. Read root files
  for (const fileName of files) {
    if (!ALLOWED_ROOT_FILES.has(fileName)) {
      result.errors.push({ path: fileName, error: 'not_allowed' });
      log?.debug?.(`[KK-SYNC] Rejected: ${fileName} (not in whitelist)`);
      continue;
    }
    const entry = await readSingleFile(workspaceDir, fileName);
    if (entry.error) {
      result.errors.push({ path: fileName, error: entry.error });
    } else {
      totalSize += entry.size;
      if (totalSize > MAX_TOTAL_SIZE) {
        log?.warn?.(`[KK-SYNC] Total size limit reached (${totalSize} > ${MAX_TOTAL_SIZE}), truncating`);
        break;
      }
      result.files.push(entry);
    }
  }

  // 2. Recursively read allowed directories
  for (const dirName of include_dirs) {
    if (!ALLOWED_DIRS.has(dirName)) continue;
    if (totalSize > MAX_TOTAL_SIZE) break;

    const dirPath = path.join(workspaceDir, dirName);
    try {
      const dirFiles = await readdir(dirPath);
      for (const f of dirFiles) {
        if (!f.endsWith('.md')) continue;
        if (BLOCKED_FILES.has(f)) continue;
        if (totalSize > MAX_TOTAL_SIZE) break;

        const relPath = `${dirName}/${f}`;
        const entry = await readSingleFile(workspaceDir, relPath);
        if (entry.error) {
          result.errors.push({ path: relPath, error: entry.error });
        } else {
          totalSize += entry.size;
          result.files.push(entry);
        }
      }
    } catch {
      // Directory doesn't exist — silently skip
    }
  }

  log?.info?.(`[KK-SYNC] file_response — files=${result.files.length} errors=${result.errors.length} totalSize=${totalSize}`);
  ws.send(JSON.stringify(result));
}

/**
 * Handle admin.file_push — write whitelisted files to agent workspace.
 * 处理 admin.file_push — 将白名单文件写入 agent 工作区。
 *
 * @param {object} data - Parsed WS event data
 * @param {string} workspaceDir - Agent workspace directory (from SDK)
 * @param {WebSocket} ws - WebSocket connection
 * @param {object} log - Logger
 */
export async function handleFilePush(data, workspaceDir, ws, log) {
  const { request_id, files = [] } = data;
  const result = { event: 'admin.file_push_ack', request_id, results: [], errors: [] };

  log?.info?.(`[KK-SYNC] file_push received — request_id=${request_id} files=${files.length}`);

  for (const file of files) {
    const { path: filePath, content } = file;

    // Security: path traversal check
    const fullPath = path.resolve(workspaceDir, filePath);
    if (!fullPath.startsWith(path.resolve(workspaceDir) + path.sep) && fullPath !== path.resolve(workspaceDir)) {
      result.errors.push({ path: filePath, error: 'not_allowed' });
      log?.warn?.(`[KK-SYNC] Path traversal blocked: ${filePath}`);
      continue;
    }

    // Security: blocked files
    const baseName = path.basename(filePath);
    if (BLOCKED_FILES.has(baseName)) {
      result.errors.push({ path: filePath, error: 'not_allowed' });
      log?.warn?.(`[KK-SYNC] Blocked file rejected: ${filePath}`);
      continue;
    }

    // Security: whitelist check
    const parts = filePath.split('/');
    const isRootFile = parts.length === 1 && ALLOWED_ROOT_FILES.has(parts[0]);
    const isDirFile = parts.length === 2 && ALLOWED_DIRS.has(parts[0]) && parts[1].endsWith('.md');
    if (!isRootFile && !isDirFile) {
      result.errors.push({ path: filePath, error: 'not_allowed' });
      log?.debug?.(`[KK-SYNC] Write rejected (not whitelisted): ${filePath}`);
      continue;
    }

    // Size check
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_SIZE) {
      result.errors.push({ path: filePath, error: 'too_large' });
      continue;
    }

    try {
      // Ensure parent directory exists
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf-8');
      result.results.push({ path: filePath, status: 'ok' });
      log?.info?.(`[KK-SYNC] File written: ${filePath}`);
    } catch (err) {
      result.errors.push({ path: filePath, error: 'write_error' });
      log?.warn?.(`[KK-SYNC] Write failed: ${filePath} — ${err.message}`);
    }
  }

  log?.info?.(`[KK-SYNC] file_push_ack — ok=${result.results.length} errors=${result.errors.length}`);
  ws.send(JSON.stringify(result));
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function readSingleFile(workspaceDir, relativePath) {
  // Path traversal check
  const fullPath = path.resolve(workspaceDir, relativePath);
  if (!fullPath.startsWith(path.resolve(workspaceDir) + path.sep) && fullPath !== path.resolve(workspaceDir)) {
    return { error: 'not_allowed' };
  }

  // Blocked file check
  const baseName = path.basename(relativePath);
  if (BLOCKED_FILES.has(baseName)) {
    return { error: 'not_allowed' };
  }

  try {
    const fileStat = await stat(fullPath);
    if (fileStat.size > MAX_FILE_SIZE) {
      return { error: 'too_large' };
    }
    const content = await readFile(fullPath, 'utf-8');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    return { path: relativePath, content, hash, size: fileStat.size };
  } catch {
    return { error: 'not_found' };
  }
}
