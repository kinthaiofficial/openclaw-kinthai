/**
 * Tests for plugin-base.js — config adapter, setupWizard.
 * 插件基础模块测试 — 配置 adapter、setupWizard。
 */

import { TestRunner, assert, assertEqual } from './helpers.js';
import { kinthaiPluginBase } from '../src/plugin-base.js';

const t = new TestRunner('Plugin Base + setupWizard Tests');

// ── config adapter ───────────────────────────────────────────────────────────

t.test('id is "kinthai"', () => {
  assertEqual(kinthaiPluginBase.id, 'kinthai', 'id');
});

t.test('capabilities: group + dm + reply', () => {
  const c = kinthaiPluginBase.capabilities;
  assert(c.chatTypes.includes('group'), 'group');
  assert(c.chatTypes.includes('dm'), 'dm');
  assert(c.reply === true, 'reply');
});

t.test('config.listAccountIds returns default when configured', () => {
  const cfg = { channels: { kinthai: { email: 'a@b.com' } } };
  assertEqual(kinthaiPluginBase.config.listAccountIds(cfg)[0], 'default', 'default account');
});

t.test('config.listAccountIds empty when not configured', () => {
  assertEqual(kinthaiPluginBase.config.listAccountIds({}).length, 0, 'empty');
});

t.test('config.isConfigured: true when email set', () => {
  assertEqual(kinthaiPluginBase.config.isConfigured({ email: 'a@b.com' }), true, 'configured');
});

t.test('config.isConfigured: false when email missing', () => {
  assertEqual(kinthaiPluginBase.config.isConfigured({}), false, 'not configured');
  assertEqual(kinthaiPluginBase.config.isConfigured(null), false, 'null account');
});

t.test('config.isConfigured: url presence does NOT matter (hardcoded)', () => {
  // v2.6.0: url is hardcoded, not part of config
  assertEqual(kinthaiPluginBase.config.isConfigured({ url: 'https://x.com' }), false,
    'url alone is not enough');
  assertEqual(kinthaiPluginBase.config.isConfigured({ url: 'https://x.com', email: 'a@b.com' }), true,
    'email required');
});

// ── setupWizard ──────────────────────────────────────────────────────────────

t.test('setupWizard exists', () => {
  assert(kinthaiPluginBase.setupWizard, 'setupWizard present');
  assertEqual(kinthaiPluginBase.setupWizard.channel, 'kinthai', 'channel id');
});

t.test('setupWizard.status.resolveConfigured matches email presence', async () => {
  const rc = kinthaiPluginBase.setupWizard.status.resolveConfigured;
  assertEqual(await rc({ cfg: { channels: { kinthai: { email: 'x@y.com' } } } }), true, 'with email');
  assertEqual(await rc({ cfg: { channels: { kinthai: {} } } }), false, 'without email');
  assertEqual(await rc({ cfg: {} }), false, 'no channel');
});

t.test('setupWizard has email textInput with validation', () => {
  const inputs = kinthaiPluginBase.setupWizard.textInputs;
  assert(Array.isArray(inputs), 'textInputs is array');
  const emailInput = inputs.find(i => i.inputKey === 'email');
  assert(emailInput, 'email input present');
  assert(emailInput.required === true, 'email required');
  assert(typeof emailInput.validate === 'function', 'has validate');
});

t.test('setupWizard email validate: empty → error', () => {
  const v = kinthaiPluginBase.setupWizard.textInputs.find(i => i.inputKey === 'email').validate;
  assert(v({ value: '' }), 'empty rejected');
  assert(v({ value: '   ' }), 'whitespace rejected');
});

t.test('setupWizard email validate: invalid → error', () => {
  const v = kinthaiPluginBase.setupWizard.textInputs.find(i => i.inputKey === 'email').validate;
  assert(v({ value: 'notanemail' }), 'no @ rejected');
});

t.test('setupWizard email validate: valid → undefined (ok)', () => {
  const v = kinthaiPluginBase.setupWizard.textInputs.find(i => i.inputKey === 'email').validate;
  assertEqual(v({ value: 'alice@example.com' }), undefined, 'valid email ok');
});

t.test('setupWizard email applySet writes channels.kinthai.email', () => {
  const input = kinthaiPluginBase.setupWizard.textInputs.find(i => i.inputKey === 'email');
  const cfg = {};
  const out = input.applySet({ cfg, accountId: 'default', value: 'alice@example.com' });
  assertEqual(out.channels.kinthai.email, 'alice@example.com', 'email set');
});

t.test('setupWizard email applySet preserves other channels.kinthai fields', () => {
  const input = kinthaiPluginBase.setupWizard.textInputs.find(i => i.inputKey === 'email');
  const cfg = { channels: { kinthai: { someOtherField: 'keep' } } };
  const out = input.applySet({ cfg, accountId: 'default', value: 'alice@example.com' });
  assertEqual(out.channels.kinthai.email, 'alice@example.com', 'email set');
  assertEqual(out.channels.kinthai.someOtherField, 'keep', 'other fields preserved');
});

t.test('setupWizard email currentValue reads from cfg', async () => {
  const input = kinthaiPluginBase.setupWizard.textInputs.find(i => i.inputKey === 'email');
  const cfg = { channels: { kinthai: { email: 'existing@example.com' } } };
  const cur = await input.currentValue({ cfg });
  assertEqual(cur, 'existing@example.com', 'currentValue');
});

// ── Run ──────────────────────────────────────────────────────────────────────

const ok = await t.run();
process.exit(ok ? 0 : 1);
