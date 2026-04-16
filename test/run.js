#!/usr/bin/env node
/**
 * Test runner — runs all test suites sequentially.
 * 测试运行器 — 依次运行所有测试套件。
 *
 * Usage:
 *   node test/run.js              # run all
 *   node test/run.js register     # run specific suite
 *   node test/run.js api          # run specific suite
 */

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];

const suites = [
  { name: 'register', file: 'test-register.js' },
  { name: 'api', file: 'test-api.js' },
];

const toRun = filter
  ? suites.filter(s => s.name === filter)
  : suites;

if (toRun.length === 0) {
  console.error(`Unknown suite: ${filter}`);
  console.error(`Available: ${suites.map(s => s.name).join(', ')}`);
  process.exit(1);
}

let allPassed = true;

for (const suite of toRun) {
  console.log(`\n>> Running: ${suite.name}\n`);
  try {
    execSync(`node ${join(__dirname, suite.file)}`, {
      stdio: 'inherit',
      cwd: join(__dirname, '..'),
    });
  } catch {
    allPassed = false;
  }
}

console.log(allPassed ? '\n✅ All suites passed' : '\n❌ Some suites failed');
process.exit(allPassed ? 0 : 1);
