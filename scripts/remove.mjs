#!/usr/bin/env node
/**
 * Legacy entry — delegates to setup.mjs.
 * 历史入口 — 委派给 setup.mjs 的 remove 命令。
 *
 * Kept for backward compatibility with older plugin installations that copied
 * remove.mjs into the plugin directory. New code should use setup.mjs directly.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const setupPath = join(__dirname, 'setup.mjs');

export async function main() {
  // Forward to setup.mjs with `remove` command (legacy behavior = remove all)
  execFileSync('node', [setupPath, 'remove'], { stdio: 'inherit' });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('remove.mjs')) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
