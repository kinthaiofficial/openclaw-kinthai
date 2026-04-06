/**
 * WebSocket connection lifecycle: connect, reconnect, event dispatch.
 * WebSocket 连接生命周期：连接、重连、事件分发。
 *
 * v2.2.0: Dispatch queue + debounce batching for group chat scalability.
 *   - Sliding window semaphore: limits concurrent AI dispatches (default 4)
 *   - Per-conversation debounce: accumulates rapid messages, flushes as batch
 */

// ── Dispatch queue (sliding window semaphore) ────────────────────────────────
// 并发信号量 — 控制同时进行的 AI dispatch 数量
const MAX_CONCURRENT = 4;
let activeDispatches = 0;
const dispatchQueue = [];

function enqueueDispatch(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeDispatches++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally {
        activeDispatches--;
        if (dispatchQueue.length > 0) dispatchQueue.shift()();
      }
    };
    if (activeDispatches < MAX_CONCURRENT) run();
    else dispatchQueue.push(run);
  });
}

// ── Debounce batching (per conversation) ─────────────────────────────────────
// 按 conversation 积攒消息，静默后一次性 flush
const DEBOUNCE_MS = 3000;   // 3s quiet → flush
const MAX_WAIT_MS = 15000;  // force flush after 15s even if messages keep coming
const MAX_BATCH = 20;       // flush immediately if batch reaches this size

// Map<conversationId, { events[], debounceTimer, forceTimer }>
const pendingBatches = new Map();

function addToPending(convId, event, flushFn) {
  if (!pendingBatches.has(convId)) {
    pendingBatches.set(convId, {
      events: [],
      debounceTimer: null,
      forceTimer: setTimeout(() => flushBatch(convId, flushFn), MAX_WAIT_MS),
    });
  }
  const batch = pendingBatches.get(convId);
  batch.events.push(event);

  // Reset debounce timer on each new message
  clearTimeout(batch.debounceTimer);
  batch.debounceTimer = setTimeout(() => flushBatch(convId, flushFn), DEBOUNCE_MS);

  // Immediate flush if batch is full
  if (batch.events.length >= MAX_BATCH) {
    clearTimeout(batch.debounceTimer);
    flushBatch(convId, flushFn);
  }
}

function flushBatch(convId, flushFn) {
  const batch = pendingBatches.get(convId);
  if (!batch || batch.events.length === 0) {
    pendingBatches.delete(convId);
    return;
  }
  clearTimeout(batch.debounceTimer);
  clearTimeout(batch.forceTimer);
  const events = batch.events;
  pendingBatches.delete(convId);
  flushFn(events);
}

export function createConnection(api, state, messageHandler, ctx) {
  const log = ctx.log;
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

      // Debounce: accumulate per conversation, flush after quiet period
      // 按 conversation 积攒，静默后批量 flush
      const convId = event.conversation_id;
      addToPending(convId, event, (batchedEvents) => {
        // Enqueue the batch into the concurrency-limited dispatch queue
        // 批量入队，受并发信号量控制
        enqueueDispatch(async () => {
          try {
            if (batchedEvents.length === 1) {
              // Single message — normal path
              await messageHandler.handleMessageEvent(batchedEvents[0]);
            } else {
              // Batched messages — pass all events
              log?.info?.(
                `[KK-I022] Batched dispatch — conv=${convId} ` +
                `messages=${batchedEvents.length} ids=[${batchedEvents.map(e => e.message_id).join(',')}]`,
              );
              await messageHandler.handleMessageEvent(batchedEvents[0], batchedEvents);
            }
          } catch (err) {
            log?.error?.(
              `[KK-E006] handleMessageEvent uncaught error — conv=${convId} ` +
              `batch=${batchedEvents.length}: ${err.message}\n${err.stack || ''}`,
            );
          }
        }).catch(() => {}); // enqueueDispatch errors already logged above
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
