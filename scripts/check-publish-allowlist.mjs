#!/usr/bin/env node
/**
 * prepublishOnly guard: assert the set of files npm is about to publish
 * exactly matches a committed allowlist. Prevents accidental leaks of
 * maintainer-only files into the public tarball.
 *
 * If the allowlist needs to change (intentional add/remove), update
 * scripts/publish-allowlist.json — which makes the change visible in
 * the diff/PR review.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = resolve(__dirname, 'publish-allowlist.json');

const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: PKG_ROOT,
  encoding: 'utf8',
});
const pkg = JSON.parse(out)[0];
const actual = pkg.files.map(f => f.path).sort();

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')).files.slice().sort();

const extra = actual.filter(f => !allowlist.includes(f));
const missing = allowlist.filter(f => !actual.includes(f));

if (extra.length || missing.length) {
  console.error('\n[publish-allowlist] TARBALL DOES NOT MATCH ALLOWLIST — publish aborted.\n');
  if (extra.length) {
    console.error('  Extra (would be published but NOT in allowlist):');
    for (const f of extra) console.error('    + ' + f);
  }
  if (missing.length) {
    console.error('  Missing (in allowlist but NOT in tarball):');
    for (const f of missing) console.error('    - ' + f);
  }
  console.error(`\n  If this change is intentional, update scripts/publish-allowlist.json`);
  console.error(`  and re-run publish.\n`);
  process.exit(1);
}

console.log(`[publish-allowlist] OK — ${actual.length} files match allowlist exactly.`);
