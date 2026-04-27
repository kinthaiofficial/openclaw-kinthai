/**
 * Tests for src/messages.js — error classification + rate_limit notice dedup.
 *
 * Both helpers are pure (or mutate-an-explicit-arg) so we can exercise them
 * without spinning a mock server or constructing the full handler closure.
 * The deliverReply integration that combines them is short and obvious; the
 * bug-prone parts (regex classification, dedup window) are isolated here.
 */

import { TestRunner, assert, assertEqual } from './helpers.js';
import {
  classifyReplyError,
  rateLimitNoticeDedup,
  RATE_LIMIT_NOTICE_DEDUP_MS,
  createMessageHandler,
} from '../src/messages.js';

const t = new TestRunner('Messages Error Classify Tests');

// ── classifyReplyError ───────────────────────────────────────────────────────

t.test('classify: normal text → null', () => {
  assertEqual(classifyReplyError('Hello, here is your reply.', false), null);
});

t.test('classify: empty text + isError=false → null', () => {
  assertEqual(classifyReplyError('', false), null);
});

t.test('classify: "LLM request rejected: ..." prefix without rate-limit signal → other', () => {
  assertEqual(classifyReplyError('LLM request rejected: invalid api key', false), 'other');
});

t.test('classify: rate limit phrases → rate_limited', () => {
  const cases = [
    'LLM request rejected: rate limit exceeded',
    'Provider returned 429 Too Many Requests',
    'rate_limit',
    'rate-limit hit on anthropic',
    'quota exceeded for this minute',
    'request was throttled by upstream',
    'RATE LIMIT EXCEEDED',
    'Too Many Requests',
  ];
  for (const text of cases) {
    assertEqual(classifyReplyError(text, true), 'rate_limited', `"${text}"`);
  }
});

t.test('classify: 429 must be word-boundary, not 4290', () => {
  assertEqual(classifyReplyError('error code 4290 occurred', true), 'other');
});

t.test('classify: isError=true without "LLM request rejected" still classifies', () => {
  assertEqual(classifyReplyError('rate limit', true), 'rate_limited');
  assertEqual(classifyReplyError('something broke', true), 'other');
});

t.test('classify: isError=false + non-LLM-rejected text containing "rate limit" → null (passes through as normal text)', () => {
  // We don't want to suppress agent's normal reply that happens to mention the
  // phrase "rate limit" in user-visible discussion.
  assertEqual(classifyReplyError('We discussed rate limits earlier', false), null);
});

// ── rateLimitNoticeDedup ─────────────────────────────────────────────────────

t.test('dedup: fresh Map → allow:true', () => {
  const m = new Map();
  const r = rateLimitNoticeDedup(m, 'conv-1', 1_000_000, 30_000);
  assertEqual(r.allow, true, 'first notice allowed');
  assertEqual(m.get('conv-1'), 1_000_000, 'timestamp recorded');
});

t.test('dedup: second call within window → allow:false with ageMs', () => {
  const m = new Map();
  rateLimitNoticeDedup(m, 'conv-1', 1_000_000, 30_000);
  const r = rateLimitNoticeDedup(m, 'conv-1', 1_005_000, 30_000);
  assertEqual(r.allow, false, 'second notice within 5s deduped');
  assertEqual(r.ageMs, 5_000, 'ageMs reported correctly');
});

t.test('dedup: call after window → allow:true again', () => {
  const m = new Map();
  rateLimitNoticeDedup(m, 'conv-1', 1_000_000, 30_000);
  const r = rateLimitNoticeDedup(m, 'conv-1', 1_031_000, 30_000);
  assertEqual(r.allow, true, '31s after first should re-allow');
  assertEqual(m.get('conv-1'), 1_031_000, 'timestamp updated');
});

t.test('dedup: different conv ids do not interfere', () => {
  const m = new Map();
  const r1 = rateLimitNoticeDedup(m, 'conv-A', 1_000_000, 30_000);
  const r2 = rateLimitNoticeDedup(m, 'conv-B', 1_000_500, 30_000);
  assertEqual(r1.allow, true, 'A allowed');
  assertEqual(r2.allow, true, 'B independent of A');
});

t.test('dedup: default DEDUP_MS is 30s', () => {
  assertEqual(RATE_LIMIT_NOTICE_DEDUP_MS, 30_000, 'documented default 30s');
});

// ── createMessageHandler smoke ───────────────────────────────────────────────

t.test('createMessageHandler returns a handler object given valid inputs', () => {
  const api = {
    sendMessage: async () => ({ message_id: 'm1' }),
    getRoleContext: async () => null,
    getMembers: async () => [],
    getMessages: async () => ({ messages: [] }),
    getConversation: async () => ({}),
    reportModel: async () => ({ ok: true }),
  };
  const fileHandler = { processFileMarkers: async (text) => ({ text, fileIds: [] }) };
  const state = { agentId: 'test', kithUserId: 'u_x' };
  const ctx = {
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    cfg: {},
    channelRuntime: {},
  };
  const handler = createMessageHandler(api, fileHandler, state, ctx);
  assert(handler && typeof handler === 'object', 'handler returned');
});

// ── Run ──────────────────────────────────────────────────────────────────────

const ok = await t.run();
process.exit(ok ? 0 : 1);
