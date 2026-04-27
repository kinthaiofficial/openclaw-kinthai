#!/usr/bin/env node
/**
 * Test runner — runs all test suites sequentially.
 * 测试运行器 — 依次运行所有测试套件。
 *
 * Usage:
 *   node test/run.js              # run all unit tests (no server needed)
 *   node test/run.js register     # run specific suite
 *   node test/run.js api          # run specific suite
 *   node test/run.js install      # run install tests (needs real OpenClaw instance)
 *   node test/run.js all          # run everything including install tests
 */

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];

// Unit tests: run anywhere with mock server (no real OpenClaw needed)
const unitSuites = [
  { name: 'register', file: 'test-register.js' },
  { name: 'register-edge', file: 'test-register-edge.js' },
  { name: 'api', file: 'test-api.js' },
  { name: 'websocket', file: 'test-websocket.js' },
  { name: 'plugin-base', file: 'test-plugin-base.js' },
  { name: 'lifecycle', file: 'test-lifecycle.js' },
  // v3.0.0 dynamic tool registration
  { name: 'tools-local-primitives', file: 'test-tools-local-primitives.js' },
  { name: 'tools-continuation', file: 'test-tools-continuation.js' },
  { name: 'tools-dynamic-registry', file: 'test-tools-dynamic-registry.js' },
  { name: 'api-tools', file: 'test-api-tools.js' },
];

// Integration tests: need real OpenClaw instance (run on 10.8.4.11)
const integrationSuites = [
  { name: 'install', file: 'test-install.js' },
  { name: 'upgrade', file: 'test-upgrade.js' },
];

const allSuites = [...unitSuites, ...integrationSuites];

const toRun = filter === 'all'
  ? allSuites
  : filter
    ? allSuites.filter(s => s.name === filter)
    : unitSuites;  // default: unit tests only

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
