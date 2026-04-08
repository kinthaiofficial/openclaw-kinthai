/**
 * WebSocket connection lifecycle: connect, reconnect, event dispatch.
 * WebSocket 连接生命周期：连接、重连、事件分发。
 *
 * v2.2.0: Dispatch queue + debounce batching for group chat scalability.
 *   - Sliding window semaphore: limits concurrent AI dispatches (default 4)
 *   - Per-conversation debounce: accumulates rapid messages, flushes as batch
 */

// Module-level logger — set by the first createConnection call
// 模块级日志引用 — 由首个 createConnection 调用设置
let _log = null;

// ── Per-conversation dispatch state ──────────────────────────────────────────
// 每个 conversation 独立的队列、冻结、等人类消息状态
// 不同群互不影响
const MAX_CONCURRENT_PER_CONV = 2;     // 每个对话同时处理的 dispatch 数
const QUEUE_FREEZE_THRESHOLD = 8;      // queue > 8 → freeze
const QUEUE_THAW_THRESHOLD = 1;        // queue ≤ 1 → thaw
const DEBOUNCE_MS = 3000;              // 3s quiet → flush
const MAX_WAIT_MS = 15000;             // force flush after 15s
const MAX_BATCH = 20;                  // flush immediately if batch reaches this

// Map<convId, { queue[], active, frozen, waitingForHuman, pending{events[], debounceTimer, forceTimer, flushFn} }>
const convStates = new Map();

function getConvState(convId) {
  if (!convStates.has(convId)) {
    convStates.set(convId, {
      queue: [],
      active: 0,
      frozen: false,
      waitingForHuman: false,
      pending: null, // debounce batch
    });
  }
  return convStates.get(convId);
}

function enqueueDispatch(convId, fn) {
  const s = getConvState(convId);
  return new Promise((resolve, reject) => {
    const run = async () => {
      s.active++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally {
        s.active--;
        if (s.queue.length > 0) {
          _log?.debug?.(`[KK-Q] Dispatch next — conv=${convId} queue=${s.queue.length} active=${s.active}`);
          s.queue.shift()();
        }
        checkThaw(convId);
      }
    };
    if (s.active < MAX_CONCURRENT_PER_CONV) {
      run();
    } else {
      s.queue.push(run);
      _log?.info?.(`[KK-Q] Dispatch queued — conv=${convId} queue=${s.queue.length} active=${s.active}`);
      checkFreeze(convId);
    }
  });
}

function checkFreeze(convId) {
  const s = getConvState(convId);
  if (!s.frozen && s.queue.length > QUEUE_FREEZE_THRESHOLD) {
    s.frozen = true;
    _log?.warn?.(
      `[KK-Q] ⚠ FROZEN — conv=${convId} queue=${s.queue.length} active=${s.active}. ` +
      `New messages will accumulate until thaw.`,
    );
  }
}

function checkThaw(convId) {
  const s = getConvState(convId);
  if (!s.frozen || s.queue.length > QUEUE_THAW_THRESHOLD) return;

  s.frozen = false;
  s.waitingForHuman = true;
  _log?.warn?.(
    `[KK-Q] ✓ THAWED — conv=${convId} queue=${s.queue.length} active=${s.active}. ` +
    `Flushing pending, then waiting for human message.`,
  );
  // Flush pending batch accumulated during freeze
  const p = s.pending;
  if (p && p.events.length > 0 && p.flushFn) {
    clearTimeout(p.debounceTimer);
    clearTimeout(p.forceTimer);
    const events = p.events;
    const fn = p.flushFn;
    s.pending = null;
    fn(events);
  }
}

function addToPending(convId, event, flushFn) {
  const s = getConvState(convId);
  if (!s.pending) {
    s.pending = { events: [], debounceTimer: null, forceTimer: null, flushFn };
  }
  const p = s.pending;
  p.events.push(event);
  p.flushFn = flushFn;

  // Frozen → accumulate only, no flush
  if (s.frozen) {
    clearTimeout(p.debounceTimer);
    clearTimeout(p.forceTimer);
    _log?.debug?.(`[KK-Q] Frozen accumulate — conv=${convId} pending=${p.events.length}`);
    return;
  }

  // Reset debounce timer
  clearTimeout(p.debounceTimer);
  p.debounceTimer = setTimeout(() => flushBatch(convId, flushFn), DEBOUNCE_MS);

  // Set force timer if not already set
  if (!p.forceTimer) {
    p.forceTimer = setTimeout(() => flushBatch(convId, flushFn), MAX_WAIT_MS);
  }

  // Immediate flush if batch is full
  if (p.events.length >= MAX_BATCH) {
    clearTimeout(p.debounceTimer);
    flushBatch(convId, flushFn);
  }
}

function flushBatch(convId, flushFn) {
  const s = getConvState(convId);
  const p = s.pending;
  if (!p || p.events.length === 0) {
    s.pending = null;
    return;
  }
  clearTimeout(p.debounceTimer);
  clearTimeout(p.forceTimer);
  const events = p.events;
  s.pending = null;
  _log?.info?.(
    `[KK-Q] Debounce flush — conv=${convId} batch=${events.length} ` +
    `queue=${s.queue.length} active=${s.active}`,
  );
  flushFn(events);
}

export function createConnection(api, state, messageHandler, ctx) {
  const log = ctx.log;
  if (!_log) _log = log; // 设置模块级日志
  let ws = null;
  let reconnectTimer = null;
  let pingTimer = null;
  let stopped = false;

  // Message deduplication — prevent duplicate processing on WS reconnect
  // 消息去重 — 防止 WS 重连时重复处理
  const recentMessageIds = new Map(); // messageId → timestamp
  const DEDUPE_TTL_MS = 20 * 60_000; // 20 minutes
  const DEDUPE_MAX = 5000;

  function isDuplicate(messageId) {
    if (!messageId) return false;
    const now = Date.now();
    // Prune expired entries when approaching max
    // 接近上限时清理过期条目
    if (recentMessageIds.size >= DEDUPE_MAX) {
      for (const [id, ts] of recentMessageIds) {
        if (now - ts > DEDUPE_TTL_MS) recentMessageIds.delete(id);
      }
    }
    if (recentMessageIds.has(messageId)) return true;
    recentMessageIds.set(messageId, now);
    return false;
  }

  // Exponential backoff for reconnection: 5s → 10s → 20s → 40s → ... → 300s max
  // 指数退避重连：5s → 10s → 20s → 40s → ... → 最大 300s
  const RECONNECT_BASE_MS = 5000;
  const RECONNECT_MAX_MS = 300_000; // 5 minutes
  let reconnectAttempts = 0;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    reconnectAttempts++;
    log?.info?.(`[KK-W001] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  function connect() {
    if (stopped) return;

    const wsUrl = state.wsUrl;
    const wsConnUrl = `${wsUrl}/ws?token=${encodeURIComponent(api.token)}`;
    log?.info?.(`[KK-I003] WebSocket connecting to ${wsUrl}/ws`);

    ws = new WebSocket(wsConnUrl);
    state.ws = ws;

    ws.onopen = () => {
      log?.info?.('[KK-I004] WebSocket connected');
      state.connectedAt = Date.now();
      reconnectAttempts = 0; // Reset backoff on successful connection
      // Client-side heartbeat to prevent VPC router conntrack timeout
      // 客户端心跳，防止跨子网路由器 conntrack 超时
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: 'ping', ts: Date.now() }));
        }
      }, 30_000);
    };

    ws.onmessage = async (msgEvent) => {
      let event;
      try {
        event = JSON.parse(msgEvent.data);
      } catch (err) {
        log?.warn?.(`[KK-E003] Message parse error — raw frame ignored: ${err.message}`);
        return;
      }

      // hello → identify
      if (event.event === 'hello') {
        ws.send(JSON.stringify({
          event: 'identify',
          api_key: api.token,
          plugin_version: state.pluginVersion,
        }));
        log?.info?.(`[KK-I005] WebSocket identified as agent "${state.kithUserId}" (v${state.pluginVersion})`);
        return;
      }

      // ping → pong
      if (event.event === 'ping') {
        ws.send(JSON.stringify({ event: 'pong', ts: event.ts }));
        state.lastPong = Date.now();
        log?.debug?.('[KK-I006] ping → pong');
        return;
      }

      // admin.command → delegate to updater (dynamic import for hot-reload)
      // admin.command → 委派给 updater（动态 import 支持热更新）
      if (event.event === 'admin.command') {
        import('./updater.js').then(m => m.handleAdminCommand(event, api, state, log)).catch(err => {
          log?.error?.(`[KK-E007] Failed to load updater.js: ${err.message}`);
        });
        return;
      }

      // role.updated → invalidate cached role context
      if (event.event === 'role.updated' && event.conversation_id) {
        import('./index.js').then(m => m.invalidateRoleContext(event.conversation_id)).catch(() => {});
        log?.info?.(`[KK-I027] Role context invalidated — conv=${event.conversation_id}`);
        return;
      }

      if (event.event !== 'message.new') return;

      // Deduplicate — skip if same message_id was recently processed
      // 去重 — 跳过最近已处理过的 message_id
      if (isDuplicate(event.message_id)) {
        log?.debug?.(`[KK-I021] Duplicate message skipped: ${event.message_id}`);
        return;
      }

      log?.info?.(
        `[KK-I007] message.new received — conv=${event.conversation_id} ` +
        `msg=${event.message_id} trigger_agent=${event.trigger_agent || false}`,
      );

      if (!event.trigger_agent) return;

      const convId = event.conversation_id;
      // Per-agent per-conversation key — each agent has its own independent queue
      // 每个 agent 在每个对话中有独立的队列状态（同一进程共享模块变量）
      const agentTag = state.kithUserId || api.token.slice(-8);
      const stateKey = `${agentTag}:${convId}`;
      const cs = getConvState(stateKey);

      // Post-thaw: block agent messages until a human speaks
      // 解冻后：跳过 agent 消息，等人类发消息才恢复循环
      if (cs.waitingForHuman) {
        if (event.sender_type === 'human') {
          cs.waitingForHuman = false;
          log?.info?.(`[KK-Q] ✓ Human message received — agent=${agentTag} conv=${convId}, resuming.`);
        } else {
          log?.debug?.(
            `[KK-Q] Post-thaw skip — agent=${agentTag} conv=${convId} ` +
            `msg=${event.message_id} sender_type=${event.sender_type}`,
          );
          return;
        }
      }

      // Debounce: accumulate per conversation, flush after quiet period
      // 按 conversation 积攒，静默后批量 flush
      addToPending(stateKey, event, (batchedEvents) => {
        // Enqueue the batch into the per-agent per-conversation dispatch queue
        enqueueDispatch(stateKey, async () => {
          log?.info?.(
            `[KK-I026] Dispatch start — agent=${agentTag} conv=${convId} batch=${batchedEvents.length} ` +
            `queue=${cs.queue.length} active=${cs.active}`,
          );
          try {
            if (batchedEvents.length === 1) {
              await messageHandler.handleMessageEvent(batchedEvents[0]);
            } else {
              await messageHandler.handleMessageEvent(batchedEvents[0], batchedEvents);
            }
          } catch (err) {
            log?.error?.(
              `[KK-E006] handleMessageEvent uncaught error — conv=${convId} ` +
              `batch=${batchedEvents.length}: ${err.message}\n${err.stack || ''}`,
            );
          }
        }).catch(() => {}); // errors already logged above
      });
    };

    ws.onclose = (closeEvent) => {
      clearInterval(pingTimer);
      if (stopped) return;
      log?.warn?.(
        `[KK-W001] WebSocket disconnected (code=${closeEvent?.code || '?'} ` +
        `reason="${closeEvent?.reason || ''}")`,
      );
      scheduleReconnect();
    };

    ws.onerror = (err) => {
      log?.error?.(`[KK-E002] WebSocket error: ${err.message || 'unknown'}`);
      scheduleReconnect();
    };
  }

  function start() {
    connect();
  }

  function stop() {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);
    ws?.close();
    log?.info?.('[KK-I016] KinthAI channel stopped (abortSignal)');
  }

  return { start, stop };
}
