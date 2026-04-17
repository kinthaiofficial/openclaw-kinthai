/**
 * Tests for lifecycle hooks (onAccountRemoved clears credentials).
 * 生命周期 hook 测试（onAccountRemoved 清理 credentials）。
 */

import { mkdtemp, mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestRunner, assert, assertEqual } from './helpers.js';

const t = new TestRunner('Lifecycle Hook Tests');

async function fileExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// ── onAccountRemoved ─────────────────────────────────────────────────────────

t.test('onAccountRemoved deletes credentials/kinthai/ directory', async () => {
  // Set HOME so resolveOAuthDir picks a temp path
  const tmpHome = await mkdtemp(join(tmpdir(), 'oc-home-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    // Reset module cache so resolveOAuthDir reads new HOME
    const credDir = join(tmpHome, '.openclaw', 'credentials', 'kinthai');
    await mkdir(credDir, { recursive: true });
    const tokensFile = join(credDir, '.tokens.json');
    await writeFile(tokensFile, JSON.stringify({ agent_a: { api_key: 'kk_x' } }));
    assert(await fileExists(tokensFile), 'tokens file created');

    // Import fresh (with new HOME set) — use cache-busting query string
    const { kinthaiPlugin } = await import(`../src/plugin.js?${Date.now()}`);
    assert(kinthaiPlugin.lifecycle, 'lifecycle adapter present');
    assert(typeof kinthaiPlugin.lifecycle.onAccountRemoved === 'function', 'hook is function');

    await kinthaiPlugin.lifecycle.onAccountRemoved({ accountId: 'default' });

    assert(!await fileExists(tokensFile), 'tokens file removed');
    assert(!await fileExists(credDir), 'credentials dir removed');
  } finally {
    process.env.HOME = origHome;
    await rm(tmpHome, { recursive: true, force: true });
  }
});

t.test('onAccountRemoved is idempotent (missing dir is fine)', async () => {
  const tmpHome = await mkdtemp(join(tmpdir(), 'oc-home-'));
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    // No credentials dir exists
    const { kinthaiPlugin } = await import(`../src/plugin.js?${Date.now()}`);
    // Should not throw
    await kinthaiPlugin.lifecycle.onAccountRemoved({ accountId: 'default' });
  } finally {
    process.env.HOME = origHome;
    await rm(tmpHome, { recursive: true, force: true });
  }
});

// ── Run ──────────────────────────────────────────────────────────────────────

const ok = await t.run();
process.exit(ok ? 0 : 1);
