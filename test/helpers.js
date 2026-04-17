/**
 * Test helpers — mock openclaw context, temp filesystem, assertions.
 * 测试辅助 — 模拟 openclaw 上下文、临时文件系统、断言。
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Create a temporary OpenClaw directory structure.
 * 创建临时 OpenClaw 目录结构。
 */
export async function createTempOpenClaw(opts = {}) {
  const base = await mkdtemp(join(tmpdir(), 'oc-test-'));
  const openclawDir = join(base, '.openclaw');
  await mkdir(openclawDir, { recursive: true });

  // openclaw.json — only email, no url (hardcoded in plugin)
  // openclaw.json — 只有 email，url 硬编码
  const config = {
    gateway: { port: 18789, auth: { token: 'test-token' } },
    channels: {
      kinthai: {
        email: opts.email || 'test@example.com',
      },
    },
    plugins: { entries: { kinthai: { enabled: true } } },
  };
  await writeFile(join(openclawDir, 'openclaw.json'), JSON.stringify(config, null, 2));

  // identity/device.json (pre-created so we don't need gateway RPC)
  const identityDir = join(openclawDir, 'identity');
  await mkdir(identityDir, { recursive: true });
  const deviceId = opts.deviceId || `test-device-${randomUUID().slice(0, 8)}`;
  await writeFile(join(identityDir, 'device.json'), JSON.stringify({
    version: 1,
    deviceId,
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
    privateKeyPem: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
    createdAtMs: Date.now(),
  }));

  // agents directory
  const agentsDir = join(openclawDir, 'agents');
  await mkdir(agentsDir, { recursive: true });

  // Create agent directories
  const agentNames = opts.agents || ['main'];
  for (const name of agentNames) {
    await mkdir(join(agentsDir, name), { recursive: true });
  }

  // Plugin lives in extensions/kinthai/ (aligned with openclaw convention)
  // 插件位于 extensions/kinthai/（对齐 openclaw 官方约定）
  const pluginDir = join(openclawDir, 'extensions', 'kinthai');
  await mkdir(pluginDir, { recursive: true });

  // Tokens live in credentials/kinthai/ (survives plugin upgrade)
  // tokens 位于 credentials/kinthai/（升级插件时不会丢）
  const credentialsDir = join(openclawDir, 'credentials', 'kinthai');
  await mkdir(credentialsDir, { recursive: true });
  const tokensFilePath = join(credentialsDir, '.tokens.json');

  return {
    base,
    openclawDir,
    pluginDir,
    credentialsDir,
    tokensFilePath,
    deviceId,
    agentNames,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

/**
 * Create a mock openclaw plugin context (ctx) for startAccount.
 * 创建模拟的 openclaw 插件上下文。
 */
export function createMockCtx(opts = {}) {
  const logs = [];
  const abortController = new AbortController();

  const log = {
    info: (...args) => { logs.push({ level: 'info', args }); },
    warn: (...args) => { logs.push({ level: 'warn', args }); },
    error: (...args) => { logs.push({ level: 'error', args }); },
    debug: (...args) => { logs.push({ level: 'debug', args }); },
  };

  return {
    account: {
      url: opts.url || 'http://localhost:18900',
      wsUrl: opts.wsUrl || 'ws://localhost:18900',
      email: opts.email || 'test@example.com',
      enabled: opts.enabled !== undefined ? opts.enabled : true,
      ...opts.account,
    },
    log,
    logs,
    abortSignal: abortController.signal,
    abortController,
    channelRuntime: opts.channelRuntime || null,
  };
}

/**
 * Simple test runner.
 * 简单测试运行器。
 */
export class TestRunner {
  constructor(name) {
    this.name = name;
    this.tests = [];
    this.passed = 0;
    this.failed = 0;
    this.errors = [];
  }

  test(name, fn) {
    this.tests.push({ name, fn });
  }

  async run() {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${this.name}`);
    console.log(`${'═'.repeat(60)}\n`);

    for (const { name, fn } of this.tests) {
      try {
        await fn();
        this.passed++;
        console.log(`  ✅ ${name}`);
      } catch (err) {
        this.failed++;
        this.errors.push({ name, error: err });
        console.log(`  ❌ ${name}`);
        console.log(`     ${err.message}`);
      }
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${this.passed} passed, ${this.failed} failed, ${this.tests.length} total`);
    console.log(`${'─'.repeat(60)}\n`);

    return this.failed === 0;
  }
}

/**
 * Assert helper.
 */
export function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertIncludes(str, substr, message) {
  if (!str.includes(substr)) {
    throw new Error(`${message || 'assertIncludes'}: "${substr}" not found in "${str.slice(0, 200)}"`);
  }
}
