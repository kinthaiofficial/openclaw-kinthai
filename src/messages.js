/**
 * Message handling: build context, dispatch AI, deliver reply.
 * 消息处理：构建上下文、调度 AI、投递回复。
 *
 * v2.0: Aligned with OpenClaw SDK standard —
 *   - Uses finalizeInboundContext() + recordInboundSession()
 *   - Session key format: agent:{agentId}:kinthai:{direct|group}:{peerId}
 *   - BodyForAgent: natural language context + plain text (no JSON payload)
 *   - Media paths passed via MsgContext for OpenClaw mediaUnderstanding
 *   - History managed by OpenClaw session transcript (no local log.jsonl)
 *   - deliver callback receives info.kind (tool/block/final)
 */

import { ensureSessionDir } from './storage.js';

// Shared with index.js agent_end hook — stores model info from latest agent run
// 与 index.js 的 agent_end hook 共享 — 存储最近一次 agent 运行的模型信息
export const lastModelInfo = { value: null };

export function createMessageHandler(api, fileHandler, state, ctx) {
  const log = ctx.log;

  /**
   * Build peer label with relationship annotation.
   * 构建 peer 标签（含关系标注）。
   */
  function buildPeerLabel(member) {
    const name = member.display_name || `User#${member.id}`;
    const rel = member.relationship;
    const isAgent = member.type === 'agent';
    const isFriend = rel === 'friend';

    if (isFriend) {
      return isAgent ? `${name} (AI agent)` : name;
    }
    // External user — annotate type and relationship
    // 外部用户 — 标注类型和关系
    const typeLabel = isAgent ? 'AI agent' : 'human';
    const relLabel = rel || 'stranger';
    const label = `${name} (external, ${typeLabel}, ${relLabel})`;
    return member.bio ? `${label} — "${member.bio}"` : label;
  }

  /**
   * Build BodyForAgent — natural language context + plain message text.
   * 构建 BodyForAgent — 自然语言上下文 + 纯消息文本（方案 C）。
   */
  function buildBodyForAgent(conv, members, triggerMsg) {
    const lines = [];
    const isGroup = !conv.is_direct;
    const selfId = state.selfUserId;

    if (isGroup) {
      const memberLabels = members
        .filter(m => String(m.id) !== String(selfId))
        .map(m => buildPeerLabel(m))
        .join(', ');
      lines.push(`[Context: Group "${conv.name || conv.conversation_id}" | Members: ${memberLabels}]`);
    } else {
      const peer = members.find(m => String(m.id) !== String(selfId));
      if (peer) {
        lines.push(`[Context: DM with ${buildPeerLabel(peer)}]`);
      } else {
        lines.push(`[Context: DM with User#${triggerMsg.sender_id}]`);
      }
    }

    lines.push('');
    lines.push(triggerMsg.content || '');
    return lines.join('\n');
  }

  /**
   * Build OpenClaw-standard session key.
   * 构建 OpenClaw 标准 session key。
   */
  function buildSessionKey(conv, members) {
    const agentId = (state.agentId || 'main').trim().toLowerCase();

    if (conv.is_direct) {
      // DM: use peer_user_id
      const peer = members.find(m => String(m.id) !== String(state.selfUserId));
      const peerId = peer?.id || conv.conversation_id;
      return `agent:${agentId}:kinthai:direct:${peerId}`;
    }
    // Group: use conversation_id
    return `agent:${agentId}:kinthai:group:${conv.conversation_id}`;
  }

  /**
   * Main message handler — OpenClaw standard flow.
   * 主消息处理 — OpenClaw 标准流程。
   */
  async function handleMessageEvent(event) {
    const { conversation_id, message_id } = event;

    await ensureSessionDir(conversation_id);

    // 1. Fetch conversation + members (no longer fetching 50 messages — OpenClaw manages history)
    // 1. 获取会话和成员信息（不再获取 50 条消息 — OpenClaw 管理历史）
    log?.info?.(`[KK-I009] Fetching conversation context — conv=${conversation_id}`);
    const [conv, membersResp] = await Promise.all([
      api.getConversation(conversation_id),
      api.getMembers(conversation_id),
    ]);

    const members = membersResp.members || [];

    // 2. Find trigger message — fetch only this message
    // 2. 获取触发消息
    let triggerMsg = null;
    try {
      const messagesResp = await api.getMessages(conversation_id, 5);
      const apiMessages = messagesResp.messages || [];
      triggerMsg = apiMessages.find(m => m.message_id === message_id)
        || apiMessages[apiMessages.length - 1];
    } catch (err) {
      log?.warn?.(`[KK-W007] Failed to fetch messages: ${err.message}`);
    }

    if (!triggerMsg) {
      log?.warn?.(`[KK-W007] Trigger message not found — conv=${conversation_id} msg=${message_id}`);
      return;
    }

    const isGroup = !conv.is_direct;
    const sender = members.find(m => String(m.id) === String(triggerMsg.sender_id));
    const senderName = sender?.display_name || String(triggerMsg.sender_id);

    log?.info?.(
      `[KK-I010] Context ready — type=${isGroup ? 'group' : 'dm'} ` +
      `sender=${senderName} members=${members.length} files=${(triggerMsg.files || []).length}`,
    );

    // 3. Download attachments → media paths for OpenClaw mediaUnderstanding
    // 3. 下载附件 → 为 OpenClaw mediaUnderstanding 准备媒体路径
    const mediaResult = await fileHandler.resolveMediaForContext(
      triggerMsg.files || [],
      conversation_id,
    );

    // 4. Build session key (OpenClaw standard format)
    // 4. 构建 session key（OpenClaw 标准格式）
    const sessionKey = buildSessionKey(conv, members);

    // 5. Build BodyForAgent (Plan C: natural language context + plain text)
    // 5. 构建 BodyForAgent（方案 C：自然语言上下文 + 纯文本）
    const bodyForAgent = buildBodyForAgent(conv, members, triggerMsg);
    const rawBody = triggerMsg.content || '';

    // 6. Check channelRuntime availability
    // 6. 检查 channelRuntime 可用性
    if (!ctx.channelRuntime) {
      log?.error?.(
        '[KK-E004] channelRuntime unavailable — AI dispatch skipped. ' +
        'Known issue on Mac OpenClaw.',
      );
      return;
    }

    // 7. Build MsgContext and finalize (OpenClaw standard)
    // 7. 构建 MsgContext 并规范化（OpenClaw 标准）
    const ctxPayload = ctx.channelRuntime.reply.finalizeInboundContext({
      Body: bodyForAgent,
      BodyForAgent: bodyForAgent,
      RawBody: rawBody,
      From: isGroup ? `kinthai:group:${conversation_id}` : `kinthai:${triggerMsg.sender_id}`,
      To: `kinthai:${conversation_id}`,
      SessionKey: sessionKey,
      ChatType: isGroup ? 'group' : 'direct',
      Provider: 'kinthai',
      Surface: 'kinthai',
      SenderId: String(triggerMsg.sender_id),
      SenderName: senderName,
      MessageSid: String(message_id),
      Timestamp: triggerMsg.created_at ? new Date(triggerMsg.created_at).getTime() : Date.now(),
      ConversationLabel: isGroup
        ? (conv.name || `group:${conversation_id}`)
        : (senderName || `user:${triggerMsg.sender_id}`),
      GroupSubject: isGroup ? (conv.name || undefined) : undefined,
      WasMentioned: true,
      CommandAuthorized: true,
      OriginatingChannel: 'kinthai',
      OriginatingTo: `kinthai:${conversation_id}`,
      // Media fields for OpenClaw mediaUnderstanding
      // 媒体字段 — OpenClaw core 自动处理（图片识别/音频转文字/视频描述/文档提取）
      MediaPath: mediaResult.paths[0] || undefined,
      MediaPaths: mediaResult.paths.length > 0 ? mediaResult.paths : undefined,
      MediaType: mediaResult.types[0] || undefined,
      MediaTypes: mediaResult.types.length > 0 ? mediaResult.types : undefined,
      // Reply reference
      ReplyToId: triggerMsg.reply_to_id || undefined,
    });

    // 8. Record inbound session (OpenClaw standard)
    // 8. 记录入站会话（OpenClaw 标准）
    const storePath = ctx.channelRuntime.session.resolveStorePath(
      ctx.cfg?.session?.store,
      { agentId: state.agentId },
    );

    await ctx.channelRuntime.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey || sessionKey,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey,
        channel: 'kinthai',
        to: `kinthai:${conversation_id}`,
      },
      onRecordError: (err) => {
        log?.warn?.(`[KK-W009] recordInboundSession error: ${err}`);
      },
    });

    // 9. Dispatch AI reply (OpenClaw standard)
    // 9. 调度 AI 回复（OpenClaw 标准）
    log?.info?.(
      `[KK-I011] Dispatching to AI — conv=${conversation_id} ` +
      `from=${triggerMsg.sender_id} sessionKey=${sessionKey}`,
    );

    await ctx.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: ctx.cfg,
      dispatcherOptions: {
        deliver: async (replyPayload, info) => {
          await deliverReply(replyPayload, info, conversation_id, state);
        },
      },
    });
  }

  /**
   * Deliver AI reply to KinthAI.
   * 将 AI 回复投递到 KinthAI。
   */
  async function deliverReply(replyPayload, info, convId, state) {
    const kind = info?.kind || 'unknown';

    if (!replyPayload.text) return;

    if (replyPayload.isError || /^LLM request rejected:/i.test(replyPayload.text)) {
      log?.warn?.(`[KK-W002] LLM error suppressed (not sent to chat): ${replyPayload.text.slice(0, 160)}`);
      return;
    }

    // Build metadata for message kind (tool, reasoning, final)
    // 构建消息元数据（工具调用、推理过程、最终回复）
    const metadata = {};
    if (replyPayload.isReasoning) {
      metadata.kind = 'reasoning';
    } else if (/^Reasoning:\s*\n/i.test(replyPayload.text)) {
      // OpenClaw /reasoning on 模式：推理内容以 "Reasoning:\n" 前缀发出
      metadata.kind = 'reasoning';
    } else if (kind === 'tool') {
      metadata.kind = 'tool';
    } else if (kind === 'block') {
      metadata.kind = 'block';
    }
    // 'final' and 'unknown' don't need metadata — rendered as normal messages

    // Process [FILE:] markers — upload files to KinthAI
    // 处理 [FILE:] 标记 — 上传文件到 KinthAI
    const { text, fileIds } = await fileHandler.processFileMarkers(replyPayload.text, convId);

    const msgBody = {};
    if (text) msgBody.content = text;
    if (fileIds.length > 0) msgBody.file_ids = fileIds;
    if (!msgBody.content && !msgBody.file_ids?.length) return;
    if (Object.keys(metadata).length > 0) msgBody.metadata = metadata;

    const sent = await api.sendMessage(convId, msgBody);

    log?.info?.(
      `[KK-I012] Reply sent (${kind}) — msg=${sent?.message_id} ` +
      `chars=${text?.length || 0} files=${fileIds.length}`,
    );

    // Report LLM model info — only on final reply
    // 报告 LLM 模型信息 — 仅在 final 回复时
    if (sent?.message_id && kind === 'final') {
      const modelInfo = lastModelInfo.value;
      if (modelInfo && (Date.now() - modelInfo.ts) < 30000) {
        lastModelInfo.value = null;
        api.reportModel(sent.message_id, modelInfo.model, modelInfo.usage).catch((err) => {
          log?.warn?.(`[KK-W008] Model report failed (non-fatal): ${err.message}`);
        });
      }
    }
  }

  return { handleMessageEvent };
}
