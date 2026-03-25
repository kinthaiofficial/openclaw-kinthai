/**
 * WebSocket connection lifecycle: connect, reconnect, event dispatch.
 * WebSocket 连接生命周期：连接、重连、事件分发。
 */

export function createConnection(api, state, messageHandler, ctx) {
  const log = ctx.log;
  let ws = null;
  let reconnectTimer = null;
  let pingTimer = null;
  let stopped = false;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 5000);
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

      log?.info?.(
        `[KK-I007] message.new received — conv=${event.conversation_id} ` +
        `msg=${event.message_id} trigger_agent=${event.trigger_agent || false}`,
      );

      if (!event.trigger_agent) return;

      try {
        await messageHandler.handleMessageEvent(event);
      } catch (err) {
        log?.error?.(
          `[KK-E006] handleMessageEvent uncaught error — conv=${event.conversation_id} ` +
          `msg=${event.message_id}: ${err.message}\n${err.stack || ''}`,
        );
      }
    };

    ws.onclose = (closeEvent) => {
      clearInterval(pingTimer);
      if (stopped) return;
      log?.warn?.(
        `[KK-W001] WebSocket disconnected (code=${closeEvent?.code || '?'} ` +
        `reason="${closeEvent?.reason || ''}") — reconnecting in 5s`,
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
