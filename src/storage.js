/**
 * Local storage: session directories, log.jsonl, history.md.
 * 本地存储：会话目录、日志、历史摘要。
 */

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const WORKSPACE_KINTHAI = join(homedir(), '.openclaw/workspace/kinthai');
export const WORKSPACE_BASE = join(WORKSPACE_KINTHAI, 'sessions');

export async function ensureSessionDir(convId) {
  await mkdir(join(WORKSPACE_BASE, convId, 'files'), { recursive: true });
}

export async function appendToLog(convId, entry) {
  await appendFile(join(WORKSPACE_BASE, convId, 'log.jsonl'), JSON.stringify(entry) + '\n');
}

export async function readRecentFromLog(convId, limit = 50) {
  try {
    const content = await readFile(join(WORKSPACE_BASE, convId, 'log.jsonl'), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function getLoggedIds(convId) {
  const entries = await readRecentFromLog(convId, 200);
  return new Set(entries.map((e) => e.message_id));
}

export async function syncMessagesToLog(convId, apiMessages, downloadFn, log) {
  const existingIds = await getLoggedIds(convId);
  for (const msg of apiMessages) {
    if (existingIds.has(msg.message_id)) continue;
    await persistMessage(convId, msg, downloadFn, log);
    existingIds.add(msg.message_id);
  }
}

async function persistMessage(convId, msg, downloadFn, log) {
  const files = msg.files || [];
  const localFiles = [];

  for (const file of files) {
    try {
      const localName = await downloadFn(file, convId);
      localFiles.push({ ...file, local_name: localName });
    } catch (err) {
      log?.warn?.(`[KK-W004] File download failed (non-fatal) — file_id=${file.file_id} name=${file.original_name}: ${err.message}`);
      localFiles.push({ ...file, local_name: null });
    }
  }

  await appendToLog(convId, {
    ts: msg.created_at,
    message_id: msg.message_id,
    sender_id: msg.sender_id,
    sender_type: msg.sender_type || 'human',
    content: msg.content || '',
    files: localFiles,
  });
}

export async function loadHistory(historyPath, conversationId) {
  try {
    const content = await readFile(historyPath, 'utf-8');
    return parseHistory(content);
  } catch {
    await mkdir(dirname(historyPath), { recursive: true });
    await writeFile(
      historyPath,
      `# Session Summary (${conversationId})\n\n## background\n\n## participants\n\n## recent\n`,
    );
    return { background: '', participants: {} };
  }
}

function parseHistory(content) {
  const background = extractSection(content, 'background') || '';
  const participantsRaw = extractSection(content, 'participants') || '';
  const participants = {};

  for (const line of participantsRaw.split('\n')) {
    const m = line.match(/^(\S+):\s*(\{.*\})\s*$/);
    if (m) {
      try { participants[m[1]] = JSON.parse(m[2]); } catch { /* ignore */ }
    }
  }

  return { background, participants };
}

function extractSection(content, name) {
  const m = content.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return m ? m[1].trim() : null;
}
