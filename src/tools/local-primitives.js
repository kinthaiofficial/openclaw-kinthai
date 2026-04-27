/**
 * Local filesystem primitives invoked from the continuation protocol.
 *
 * Allowlist is passed in as a parameter on every call (NOT module-level state).
 * This is required so concurrent agent runs in the same process cannot
 * pollute each other's filesystem boundary.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Hard cap on a single base64-over-JSON read/write. Larger files must
 *  go through the multipart `upload_local_file_to_conversation` continuation. */
export const MAX_INLINE_FILE_BYTES = 8 * 1024 * 1024;

/** Maximum size for multipart upload (kept in sync with backend). */
export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Compute the allowed filesystem prefixes for a given run.
 *
 * @param {object} opts
 * @param {string} [opts.workspaceDir]
 * @returns {string[]} resolved absolute prefixes
 */
export function buildAllowlist({ workspaceDir } = {}) {
  const out = [];
  if (process.env.HOME) out.push(path.join(process.env.HOME, '.openclaw'));
  out.push('/tmp');
  if (workspaceDir) out.push(path.resolve(workspaceDir));
  return out;
}

function deny(p) {
  const err = new Error(`path_denied: ${p}`);
  err.code = 'path_denied';
  return err;
}

function notFound(p) {
  const err = new Error(`path_not_found: ${p}`);
  err.code = 'path_not_found';
  return err;
}

function tooLarge(size, limit) {
  const err = new Error(`path_too_large: ${size} > ${limit}`);
  err.code = 'path_too_large';
  return err;
}

function ensureAllowed(p, allowedPrefixes) {
  if (!Array.isArray(allowedPrefixes) || allowedPrefixes.length === 0) {
    throw deny(p);
  }
  const resolved = path.resolve(p);
  const ok = allowedPrefixes.some((prefix) =>
    resolved === prefix || resolved.startsWith(prefix + path.sep),
  );
  if (!ok) throw deny(p);
  return resolved;
}

export async function readLocalFile(p, allowedPrefixes) {
  const resolved = ensureAllowed(p, allowedPrefixes);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound(p);
    throw err;
  }
  if (stat.size > MAX_INLINE_FILE_BYTES) {
    throw tooLarge(stat.size, MAX_INLINE_FILE_BYTES);
  }
  const buf = await fs.readFile(resolved);
  return { content_b64: buf.toString('base64') };
}

export async function writeLocalFile(p, contentB64, allowedPrefixes) {
  const resolved = ensureAllowed(p, allowedPrefixes);
  const buf = Buffer.from(contentB64 || '', 'base64');
  if (buf.length > MAX_INLINE_FILE_BYTES) {
    throw tooLarge(buf.length, MAX_INLINE_FILE_BYTES);
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, buf);
  return { ok: true };
}

export async function listLocalDir(p, allowedPrefixes) {
  const resolved = ensureAllowed(p, allowedPrefixes);
  let dirents;
  try {
    dirents = await fs.readdir(resolved, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound(p);
    throw err;
  }
  const entries = await Promise.all(dirents.map(async (e) => {
    const full = path.join(resolved, e.name);
    let size = 0;
    try { size = (await fs.stat(full)).size; } catch { /* dangling symlink etc. */ }
    const kind = e.isDirectory() ? 'dir'
      : e.isSymbolicLink() ? 'symlink'
      : e.isFile() ? 'file'
      : 'other';
    return { name: e.name, kind, size };
  }));
  return { entries };
}

/**
 * Multipart-upload a local file to a KinthAI conversation. Used by the
 * `upload_local_file_to_conversation` continuation type — the recommended
 * path for files that don't fit the 8MB inline base64 cap.
 *
 * Reuses the existing `KinthaiApi.uploadFile` (multipart/form-data) so
 * binary bytes never get base64-encoded into JSON.
 */
export async function uploadLocalFileToConversation(p, conversationId, api, allowedPrefixes) {
  if (!conversationId) {
    const err = new Error('conversation_id_required');
    err.code = 'schema_invalid';
    throw err;
  }
  const resolved = ensureAllowed(p, allowedPrefixes);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound(p);
    throw err;
  }
  if (stat.size > MAX_UPLOAD_FILE_BYTES) {
    const err = new Error(`file_too_large: ${stat.size} > ${MAX_UPLOAD_FILE_BYTES}`);
    err.code = 'file_too_large';
    throw err;
  }
  const buf = await fs.readFile(resolved);
  const fileName = path.basename(resolved);
  const result = await api.uploadFile(buf, fileName, conversationId);
  return { ok: true, file_id: result.file_id };
}
