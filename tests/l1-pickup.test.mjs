#!/usr/bin/env node
/*
  PR-E: L1 cross-folder pick-up test.

  Seeds session_bookmarks across multiple directories, runs
  scripts/generate-l1.mjs with --directory pointing at one of them, and
  asserts the output includes a CROSS-FOLDER PICK-UP section that names
  both the current directory and parallel work elsewhere.
*/

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TMPDIR = mkdtempSync(join(tmpdir(), 'wmem-l1-pickup-'));
const DB_PATH = join(TMPDIR, 'memory.db');

process.env.MEMORY_DB = DB_PATH;

const report = { stages: [] };
async function stage(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    report.stages.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    report.stages.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
    console.error(`  ✗ ${name}: ${e.message}`);
  }
}

const { upsertBookmark } = await import(join(REPO_ROOT, 'core/db.mjs'));

const now = Date.now();
const HERE = '/tmp/proj-here';
const THERE = '/tmp/proj-there';
const OTHER = '/tmp/proj-other';

upsertBookmark({
  sessionId: 'sess-here-1', agent: 'l1-test', directory: HERE,
  projectName: 'wmem', startedAt: now - 7200000, endedAt: now - 3600000,
  summary: 'wired up PR-A hook integration locally',
  tags: ['hooks', 'sessionend', 'wmem'],
});
upsertBookmark({
  sessionId: 'sess-there-1', agent: 'l1-test', directory: THERE,
  projectName: 'wmem', startedAt: now - 5400000, endedAt: now - 1800000,
  summary: 'drafted the personality CLI update flow',
  tags: ['personality', 'cli', 'wmem'],
});
upsertBookmark({
  sessionId: 'sess-other-1', agent: 'l1-test', directory: OTHER,
  projectName: 'unrelated', startedAt: now - 9000000, endedAt: now - 4500000,
  summary: 'something else entirely',
  tags: ['random'],
});

function runL1(extraArgs = [], env = {}) {
  return spawnSync(process.execPath, [
    join(REPO_ROOT, 'scripts/generate-l1.mjs'),
    '--agent', 'l1-test',
    ...extraArgs,
  ], {
    env: { ...process.env, MEMORY_DB: DB_PATH, ...env },
    encoding: 'utf8',
  });
}

await stage('emits CROSS-FOLDER PICK-UP section with current directory + parallel work', () => {
  const r = runL1(['--directory', HERE]);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  assert.ok(r.stdout.includes('CROSS-FOLDER PICK-UP'),
    `missing section header; stdout:\n${r.stdout}`);
  assert.ok(r.stdout.includes('HERE'), 'missing HERE marker');
  assert.ok(r.stdout.includes('wired up PR-A hook integration'),
    'missing current-directory summary');
  assert.ok(r.stdout.includes('ELSEWHERE'), 'missing ELSEWHERE marker');
  assert.ok(r.stdout.includes('personality CLI'),
    `missing parallel-work summary; stdout:\n${r.stdout}`);
});

await stage('same_project parallel work is labeled as same project', () => {
  const r = runL1(['--directory', HERE]);
  assert.ok(r.stdout.includes('same project [wmem]'),
    `expected same-project relation label; stdout:\n${r.stdout}`);
});

await stage('absent directory: no section emitted (no current bookmark)', () => {
  const r = runL1(['--directory', '/tmp/nonexistent-dir']);
  assert.strictEqual(r.status, 0);
  // No bookmark for this directory → buildCrossFolderActivity returns null.
  assert.ok(!r.stdout.includes('CROSS-FOLDER PICK-UP'),
    'should not emit section when no bookmark exists for the directory');
});

const failures = report.stages.filter(s => !s.ok);
console.log(`\nl1-pickup: ${report.stages.length - failures.length}/${report.stages.length} pass`);
process.exit(failures.length === 0 ? 0 : 1);
