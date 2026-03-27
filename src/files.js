/**
 * File handling: download cache, upload via [FILE:] markers, media context for OpenClaw.
 * 文件处理：下载缓存、[FILE:] 标记上传、为 OpenClaw mediaUnderstanding 准备媒体上下文。
 *
 * v2.0: Text extraction and base64 encoding removed — handled by OpenClaw core.
 * v2.0: 文本提取和 base64 编码已移除，由 OpenClaw core 的 mediaUnderstanding 处理。
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, basename, isAbsolute } from 'node:path';
import { sanitizeFileName } from './utils.js';
import { WORKSPACE_KINTHAI, WORKSPACE_BASE } from './storage.js';

/**
 * Map KinthAI file_type to MIME type for OpenClaw mediaUnderstanding.
 * 将 KinthAI 的 file_type 映射为 MIME 类型。
 */
function mapFileType(fileType, mimeType) {
  if (mimeType) return mimeType;
  switch (fileType) {
    case 'image': return 'image/jpeg';
    case 'audio': return 'audio/mpeg';
    case 'video': return 'video/mp4';
    case 'document': return 'application/octet-stream';
    default: return 'application/octet-stream';
  }
}

export function createFileHandler(api, log) {
  /**
   * Download file from KinthAI backend and cache locally.
   * 从 KinthAI 后端下载文件并缓存到本地。
   */
  async function downloadAndSaveFile(file, convId) {
    const localName = `${file.file_id}_${sanitizeFileName(file.original_name)}`;
    const localPath = join(WORKSPACE_BASE, convId, 'files', localName);

    try {
      await stat(localPath);
      log?.debug?.(`[KK-I014] File already cached — ${localName}`);
      return localName;
    } catch { /* need to download */ }

    log?.info?.(`[KK-I013] Downloading file — file_id=${file.file_id} name=${file.original_name}`);
    const buffer = await api.downloadFile(file.file_id);
    await writeFile(localPath, buffer);
    log?.info?.(`[KK-I013] Downloaded ${localName} (${buffer.length} bytes)`);
    return localName;
  }

  /**
   * Download files and return paths + MIME types for OpenClaw MsgContext.
   * 下载文件并返回路径和 MIME 类型，供 OpenClaw MsgContext 使用。
   *
   * OpenClaw core will automatically apply mediaUnderstanding:
   * - Images → vision description or native model processing
   * - Audio → speech-to-text transcription
   * - Video → video description
   * - Documents → text extraction
   */
  async function resolveMediaForContext(files, convId) {
    if (!files || files.length === 0) return { paths: [], types: [] };

    const paths = [];
    const types = [];

    for (const file of files) {
      try {
        const localName = await downloadAndSaveFile(file, convId);
        const localPath = join(WORKSPACE_BASE, convId, 'files', localName);
        paths.push(localPath);
        types.push(mapFileType(file.file_type, file.mime_type));
      } catch (err) {
        log?.warn?.(`[KK-W004] File download failed — file_id=${file.file_id}: ${err.message}`);
      }
    }

    return { paths, types };
  }

  /**
   * Process [FILE:path] markers in AI reply text — upload files to KinthAI.
   * 处理 AI 回复中的 [FILE:path] 标记 — 上传文件到 KinthAI。
   */
  async function processFileMarkers(text, convId) {
    const fileIds = [];
    const markers = [...text.matchAll(/\[FILE:([^\]]+)\]/g)];
    if (markers.length === 0) return { text: text.trim(), fileIds };

    let cleanText = text;
    for (const match of markers) {
      cleanText = cleanText.replace(match[0], '');
      const rawPath = match[1].trim();
      const absPath = isAbsolute(rawPath) ? rawPath : join(WORKSPACE_KINTHAI, rawPath);

      try {
        const buffer = await readFile(absPath);
        const fileName = basename(absPath);
        log?.info?.(`[KK-I015] Uploading file to KinthAI — path=${absPath} name=${fileName}`);

        const data = await api.uploadFile(buffer, fileName, convId);
        fileIds.push(data.file_id);
        log?.info?.(`[KK-I015] File uploaded — file_id=${data.file_id}`);

        const localName = `${data.file_id}_${sanitizeFileName(fileName)}`;
        await writeFile(join(WORKSPACE_BASE, convId, 'files', localName), buffer).catch(() => {});
      } catch (err) {
        log?.warn?.(`[KK-W006] File upload failed — [FILE:] marker dropped — path=${rawPath}: ${err.message}`);
      }
    }

    return { text: cleanText.trim(), fileIds };
  }

  return { downloadAndSaveFile, resolveMediaForContext, processFileMarkers };
}
