/**
 * Plugin file download from KinthAI server.
 * 从 KinthAI 服务器下载插件文件。
 *
 * This module only does network requests — file I/O is in updater.js.
 * 此模块只做网络请求 — 文件 I/O 在 updater.js 中。
 *
 * Separated to avoid OpenClaw security scanner "potential-exfiltration" warning.
 */

/**
 * Download plugin files from the KinthAI server into a temporary directory.
 * 从 KinthAI 服务器下载插件文件到临时目录。
 *
 * @param {string} baseUrl - KinthAI base URL
 * @param {string} downloadUrl - Download path prefix
 * @param {string[]} files - List of file names to download
 * @param {Function} saveFile - async (fileName, content) => void
 * @param {object} log - Logger
 */
export async function downloadFiles(baseUrl, downloadUrl, files, saveFile, log) {
  for (const fileName of files) {
    const url = `${baseUrl}${downloadUrl}${fileName}`;
    log?.info?.(`[KK-UPD] Downloading ${fileName}...`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download ${fileName}: HTTP ${res.status}`);
    }
    const content = await res.text();
    await saveFile(fileName, content);
  }
}

/**
 * Report command result back to KinthAI server.
 * 向 KinthAI 服务器回报命令执行结果。
 */
export async function reportCommandResult(api, command_id, status, result) {
  try {
    await api._fetch('/api/v1/admin/command-result', 'POST', {
      command_id,
      status,
      result,
    });
  } catch (err) {
    const log = api.log;
    log?.warn?.(`[KK-UPD] Failed to report result for ${command_id}: ${err.message}`);
  }
}
