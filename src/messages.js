/**
 * Message handling: fetch context, build payload, dispatch AI, deliver reply.
 * 消息处理：获取上下文、构建载荷、调度 AI、投递回复。
 */

import { join } from 'node:path';
import { relativeTime, extractMentions } from './utils.js';
import { WORKSPACE_BASE, ensureSessionDir, readRecentFromLog, syncMessagesToLog, appendToLog, loadHistory } from './storage.js';

// Shared with index.js agent_end hook — stores model info from latest agent run
// 与 index.js 的 agent_end hook 共享 — 存储最近一次 agent 运行的模型信息
export const lastModelInfo = { value: null };

export function createMessageHandler(api, fileHandler, state, ctx) {
  const log = ctx.log;

  async function handleMessageEvent(event) {
    const { conversation_id, message_id } = event;

    await ensureSessionDir(conversation_id);

    log?.info?.(`[KK-I009] Fetching conversation context — conv=${conversation_id}`);

    const [conv, membersResp, messagesResp] = await Promise.all([
      api.getConversation(conversation_id),
      api.getMembers(conversation_id),
      api.getMessages(conversation_id, 50),
    ]);

    const members = membersResp.members || [];
    const apiMessages = messagesResp.messages || [];

    await syncMessagesToLog(conversation_id, apiMessages, fileHandler.downloadAndSaveFile, log);

    const triggerMsg = apiMessages.find((m) => m.message_id === message_id)
      || apiMessages[apiMessages.length - 1];

    if (!triggerMsg) {
      log?.warn?.(
        `[KK-W007] Trigger message not found in API response — ` +
        `conv=${conversation_id} msg=${message_id} apiMessages=${apiMessages.length}`,
      );
      return;
    }

    const attachments = await fileHandler.resolveAttachments(triggerMsg.files || [], conversation_id);

    const priorMessages = (await readRecentFromLog(conversation_id, 50))
      .filter((e) => e.message_id !== message_id)
      .slice(-19)
      .map((e) => ({
        id: e.message_id,
        from: e.sender_id,
        text: e.content || '',
        ago: relativeTime(e.ts),
        ...(e.files?.length > 0 ? { has_files: e.files.map((f) => f.original_name) } : {}),
      }));

    const historyPath = join(WORKSPACE_BASE, conversation_id, 'history.md');
    const history = await loadHistory(historyPath, conversation_id);

    const isGroup = !conv.is_direct;

    log?.info?.(
      `[KK-I010] Context ready — type=${isGroup ? 'group' : 'dm'} ` +
      `apiMsgs=${apiMessages.length} localMsgs=${priorMessages.length} ` +
      `attachments=${attachments.length} members=${members.length}`,
    );

    const selfId = state.selfUserId || state.kithUserId;
    const payload = isGroup
      ? buildGroupPayload(conv, members, priorMessages, triggerMsg, attachments, history, selfId)
      : buildDmPayload(conv, members, priorMessages, triggerMsg, attachments, history, selfId);

    const sessionKey = `kinthai:${conversation_id}`;

    if (!ctx.channelRuntime) {
      log?.error?.(
        `[KK-E004] channelRuntime unavailable — cannot dispatch AI reply for ` +
        `conv=${conversation_id} msg=${message_id}. ` +
        'Ensure OpenClaw is configured with a valid AI model/skill.',
      );
      return;
    }

    log?.info?.(
      `[KK-I011] Dispatching to AI via channelRuntime — conv=${conversation_id} ` +
      `from=${triggerMsg.sender_id} sessionKey=${sessionKey}`,
    );

    await ctx.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: {
        BodyForAgent: JSON.stringify(payload, null, 2),
        Body: triggerMsg.content || '',
        From: triggerMsg.sender_id,
        To: conversation_id,
        SessionKey: sessionKey,
      },
      cfg: ctx.cfg,
      dispatcherOptions: {
        deliver: async (replyPayload) => {
          await deliverReply(replyPayload, conversation_id, payload, state);
        },
      },
    });
  }

  async function deliverReply(replyPayload, convId, payload, state) {
    if (!replyPayload.text || replyPayload.isReasoning) return;

    if (replyPayload.isError || /^LLM request rejected:/i.test(replyPayload.text)) {
      log?.warn?.(`[KK-W002] LLM error suppressed (not sent to chat): ${replyPayload.text.slice(0, 160)}`);
      return;
    }

    const { text, fileIds } = await fileHandler.processFileMarkers(replyPayload.text, convId);

    const msgBody = {};
    if (text) msgBody.content = text;
    if (fileIds.length > 0) msgBody.file_ids = fileIds;
    if (!msgBody.content && !msgBody.file_ids?.length) return;

    const sent = await api.sendMessage(convId, msgBody);

    log?.info?.(
      `[KK-I012] Reply sent — msg=${sent?.message_id} ` +
      `chars=${text?.length || 0} files=${fileIds.length}`,
    );

    if (sent?.message_id) {
      // Report LLM model + usage captured by agent_end hook
      // 上报 agent_end hook 捕获的 LLM 模型和用量
      const info = lastModelInfo.value;
      if (info && (Date.now() - info.ts) < 30000) {
        lastModelInfo.value = null;
        api.reportModel(sent.message_id, info.model, info.usage).catch((err) => {
          log?.warn?.(`[KK-W008] Model report failed (non-fatal): ${err.message}`);
        });
      }

      await appendToLog(convId, {
        ts: sent.created_at || new Date().toISOString(),
        message_id: sent.message_id,
        sender_id: sent.sender_id || state.kithUserId,
        sender_type: 'agent',
        content: sent.content || text || '',
        files: (sent.files || []).map((f) => ({ ...f, local_name: null })),
      });
    }
  }

  return { handleMessageEvent };
}

function buildGroupPayload(conv, members, recentMessages, triggerMsg, attachments, history, kithUserId) {
  const participants = {};
  for (const m of members) {
    if (m.id === kithUserId) continue;
    const stored = history.participants[m.id] || {};
    participants[m.id] = {
      name: m.id,
      role: 'member',
      traits: stored.traits || '',
    };
  }

  const sender = members.find((m) => m.id === triggerMsg.sender_id);

  return {
    scene: {
      chat_id: conv.conversation_id,
      chat_type: 'group',
      chat_name: conv.name || conv.conversation_id,
      you_are: 'Kith, AI assistant and group member',
      instructions:
        `Reply to the user who triggered this message. No need to @mention them — just answer directly. ` +
        `To send files, write them to workspace then add [FILE:sessions/${conv.conversation_id}/files/filename] in your reply. ` +
        `After each reply, update workspace/kinthai/sessions/${conv.conversation_id}/history.md (background + participants + recent).`,
    },
    participants,
    context: {
      background: history.background,
      recent: recentMessages,
    },
    message: {
      id: triggerMsg.message_id,
      from: { id: triggerMsg.sender_id, name: sender?.id || triggerMsg.sender_id },
      text: triggerMsg.content || '',
      ago: 'just now',
      entities: extractMentions(triggerMsg.content || ''),
      reply_to: triggerMsg.reply_to_id || null,
      attachments,
    },
  };
}

function buildDmPayload(conv, members, recentMessages, triggerMsg, attachments, history, kithUserId) {
  const otherUser = members.find((m) => m.id !== kithUserId);
  const stored = history.participants[otherUser?.id || triggerMsg.sender_id] || {};

  return {
    scene: {
      chat_id: conv.conversation_id,
      chat_type: 'dm',
      you_are: 'Kith, AI assistant',
      instructions:
        `Direct message — reply directly. ` +
        `To send files, write them to workspace then add [FILE:sessions/${conv.conversation_id}/files/filename] in your reply. ` +
        `After each reply, update workspace/kinthai/sessions/${conv.conversation_id}/history.md with new user traits.`,
    },
    user: {
      id: otherUser?.id || triggerMsg.sender_id,
      name: otherUser?.id || triggerMsg.sender_id,
      traits: stored.traits || '',
    },
    context: {
      background: history.background,
      recent: recentMessages,
    },
    message: {
      id: triggerMsg.message_id,
      from: { id: triggerMsg.sender_id, name: otherUser?.id || triggerMsg.sender_id },
      text: triggerMsg.content || '',
      ago: 'just now',
      entities: [],
      reply_to: triggerMsg.reply_to_id || null,
      attachments,
    },
  };
}
