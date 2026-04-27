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

  async reportModel(messageId, model, usage = null, session = null) {
    if (!messageId) throw new Error('KK-V003: message_id required');
    const body = { model };
    if (usage) body.usage = usage;
    if (session) body.session = session;
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

  // ── Agent tools API (v3.0.0) ─────────────────────────────────────────────
  // See contract-agent-tools-protocol.md. All three endpoints are agent-only
  // (user_type=2 per backend authenticate middleware).

  async fetchToolManifest({ signal } = {}) {
    const url = `${this.baseUrl}/api/v1/agent/tools/manifest`;
    const res = await fetch(url, { method: 'GET', headers: this._headers(), signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.log?.warn?.(`[KK-T032] GET /api/v1/agent/tools/manifest → ${res.status}: ${text}`);
      const err = new Error(`manifest fetch failed: ${res.status}`);
      err.code = res.status === 401 ? 'unauthorized' : 'backend_unavailable';
      throw err;
    }
    return res.json();
  }

  async dispatchTool(toolName, params, dispatchId) {
    return this._fetchTool('/api/v1/agent/tools/dispatch', { tool: toolName, params }, { dispatchId });
  }

  async continueTool(continuationId, result) {
    return this._fetchTool('/api/v1/agent/tools/continue', {
      continuation_id: continuationId,
      result,
    });
  }

  /**
   * POST helper for the dispatch / continue endpoints.
   *
   * Returns a structured object on every path (never throws). Folds non-2xx
   * HTTP responses into `{ok:false, error, hint}` so callers don't need to
   * special-case 4xx and 200+ok:false separately. Implements 429 backoff
   * (3 attempts, exponential or honoring Retry-After).
   */
  async _fetchTool(path, body, { dispatchId } = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = { ...this._headers() };
    if (dispatchId) headers['X-Dispatch-Id'] = dispatchId;

    const MAX_RETRIES = 3;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
      } catch (err) {
        this.log?.warn?.(`[KK-T032] ${path} fetch threw: ${err.message}`);
        return { ok: false, error: 'backend_unavailable', hint: err.message };
      }

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
        const delayMs = retryAfter > 0 ? retryAfter * 1000 : 500 * Math.pow(2, attempt);
        this.log?.warn?.(`[KK-T031] ${path} rate_limited; backoff ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      let parsed = null;
      try { parsed = await res.json(); } catch { /* non-JSON or empty body */ }

      if (res.ok) return parsed;

      const code = res.status === 401 ? 'unauthorized'
        : res.status === 403 ? 'forbidden'
        : res.status === 410 ? 'continuation_expired'
        : res.status === 429 ? 'rate_limited'
        : res.status >= 500 ? 'backend_unavailable'
        : (parsed?.error || 'http_error');
      const hint = parsed?.hint || `HTTP ${res.status}`;
      this.log?.warn?.(`[KK-T032] ${path} → ${res.status} ${code}: ${hint}`);
      return { ok: false, error: code, hint };
    }
  }
}
