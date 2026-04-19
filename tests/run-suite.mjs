#!/usr/bin/env node
/**
 * tests/run-suite.mjs — aggregates all test files under tests/*.test.mjs
 *
 * Run: npm test
 *
 * Each test file is expected to exit 0 on success, non-zero on failure.
 * This suite exits non-zero if any child fails.
 *
 * Kept deliberately small: just a child-process runner, not a framework.
 * Test files use node:assert directly.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const testFiles = readdirSync(__dirname)
  .filter(f => f.endsWith('.test.mjs'))
  .sort();

if (testFiles.length === 0) {
  console.log('no test files found under tests/*.test.mjs');
  process.exit(0);
}

let anyFailed = false;
for (const f of testFiles) {
  console.log(`\n── ${f} ──`);
  const res = spawnSync(process.execPath, [join(__dirname, f)], { stdio: 'inherit' });
  if (res.status !== 0) anyFailed = true;
}

process.exit(anyFailed ? 1 : 0);
