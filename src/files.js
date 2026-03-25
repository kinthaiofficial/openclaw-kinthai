/**
 * File handling: download, upload, text extraction, [FILE:] markers.
 * 文件处理：下载、上传、文本提取、[FILE:] 标记。
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, basename, isAbsolute } from 'node:path';
import { sanitizeFileName } from './utils.js';
import { WORKSPACE_KINTHAI, WORKSPACE_BASE } from './storage.js';

const MAX_EXTRACT_CHARS = 25000;

export function createFileHandler(api, log) {
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

  async function getExtractedText(file, convId, localName) {
    const cachePath = join(WORKSPACE_BASE, convId, 'files', localName + '.txt');
    try {
      return await readFile(cachePath, 'utf-8');
    } catch { /* not cached */ }

    try {
      const data = await api.getFileExtract(file.file_id);
      const text = (data.text || '').slice(0, MAX_EXTRACT_CHARS);
      if (text) await writeFile(cachePath, text);
      return text;
    } catch (err) {
      log?.warn?.(`[KK-W005] File extract failed (non-fatal) — file_id=${file.file_id}: ${err.message}`);
      return '';
    }
  }

  async function resolveAttachments(files, convId) {
    if (!files || files.length === 0) return [];
    const results = [];

    for (const file of files) {
      let localName = null;
      try {
        localName = await downloadAndSaveFile(file, convId);
      } catch (err) {
        log?.warn?.(`[KK-W004] Cannot download attachment — file_id=${file.file_id}: ${err.message}`);
        results.push({ name: file.original_name, type: file.file_type, error: 'unavailable' });
        continue;
      }

      const attachment = {
        name: file.original_name,
        type: file.file_type,
        local_path: `sessions/${convId}/files/${localName}`,
      };

      if (file.file_type === 'document') {
        const text = await getExtractedText(file, convId, localName);
        if (text) attachment.text = text;
      } else if (file.file_type === 'image') {
        try {
          const buffer = await readFile(join(WORKSPACE_BASE, convId, 'files', localName));
          attachment.base64 = buffer.toString('base64');
          attachment.mime_type = file.mime_type || 'image/jpeg';
        } catch {
          attachment.note = 'Image stored locally but could not be read';
        }
      }

      results.push(attachment);
    }
    return results;
  }

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

  return { downloadAndSaveFile, resolveAttachments, processFileMarkers };
}
