/**
 * KinthaiApi — HTTP request wrapper with pure api_key authentication.
 * KinthaiApi — 使用 api_key 认证的 HTTP 请求封装。
 */

export class KinthaiApi {
  constructor(baseUrl, token, log) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.log = log;
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  async sendMessage(convId, { content, file_ids, mentions, metadata }) {
    if (!convId) throw new Error('KK-V001: conversation_id required');
    if (!content && (!file_ids?.length)) throw new Error('KK-V002: content or file_ids required');
    const body = {};
    if (content) body.content = content;
    if (file_ids?.length) body.file_ids = file_ids;
    if (mentions) body.mentions = mentions;
    if (metadata) body.metadata = metadata;
    return this._fetch(`/api/v1/conversations/${convId}/messages`, 'POST', body);
  }

  async reportModel(messageId, model, usage = null) {
    if (!messageId) throw new Error('KK-V003: message_id required');
    const body = { model };
    if (usage) body.usage = usage;
    return this._fetch(`/api/v1/messages/${messageId}/model`, 'PUT', body);
  }

  async getMe() { return this._fetch('/api/v1/users/me'); }
  async getRoleContext(convId) { return this._fetch(`/api/v1/conversations/${convId}/role-context`); }
  async getConversation(convId) { return this._fetch(`/api/v1/conversations/${convId}`); }
  async getMembers(convId) { return this._fetch(`/api/v1/conversations/${convId}/members`); }
  async getMessages(convId, limit = 30) { return this._fetch(`/api/v1/conversations/${convId}/messages?limit=${limit}`); }

  async uploadFile(buffer, fileName, convId) {
    const formData = new FormData();
    formData.append('file', new Blob([buffer]), fileName);
    formData.append('conversation_id', convId);

    const res = await fetch(`${this.baseUrl}/api/v1/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: formData,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.log?.error?.(`[KK-E005] POST /api/v1/files/upload → ${res.status}: ${text}`);
      throw new Error(`KK-E005: file upload failed (${res.status})`);
    }
    return res.json();
  }

  async downloadFile(fileId) {
    const res = await fetch(`${this.baseUrl}/api/v1/files/${fileId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async getFileExtract(fileId) {
    return this._fetch(`/api/v1/files/${fileId}/extract`);
  }

  async _fetch(path, method = 'GET', body = null) {
    const url = `${this.baseUrl}${path}`;
    const opts = { method, headers: this._headers() };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.log?.error?.(`[KK-E005] ${method} ${path} → ${res.status}: ${text}`);
      throw new Error(`KK-E005: ${method} ${path} failed (${res.status})`);
    }
    return res.json();
  }
}
