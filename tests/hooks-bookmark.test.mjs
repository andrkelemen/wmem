#!/usr/bin/env node
/*
  PR-A: SessionEnd hook bookmark + KG materialization test.

  Spawns scripts/session-end-bookmark.mjs as a subprocess, pipes Claude Code
  style stdin JSON, and asserts:
    - a session_bookmarks row lands with the right session_id, agent, directory
    - WMEM_SKIP_KG=1 skips materialization (no kg_relations rows)
    - default run materializes (rows present in kg_relations)
*/

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TMPDIR = mkdtempSync(join(tmpdir(), 'wmem-hooks-bookmark-'));
const DB_PATH = join(TMPDIR, 'memory.db');

// MUST set MEMORY_DB before importing core/db.mjs — the module captures DB_PATH
// at first import. Without this the test process and the subprocess would be
// pointed at different SQLite files.
process.env.MEMORY_DB = DB_PATH;

const report = { stages: [] };
function stage(name, fn) {
  return Promise.resolve().then(async () => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      report.stages.push({ name, ok: true, ms: Date.now() - t0, detail });
      console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
    } catch (e) {
      report.stages.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
      console.error(`  ✗ ${name}: ${e.message}`);
    }
  });
}

// Seed some chunks so KG materialization has data to work with
const { insertChunk, getDb } = await import(join(REPO_ROOT, 'core/db.mjs'));
const now = Date.now();
for (let i = 0; i < 6; i++) {
  insertChunk({
    agent: 'hook-test',
    sourceType: 'note',
    sourceId: `seed-${i}`,
    sessionId: 'hook-sess-1',
    content: ['auth flow', 'database migration', 'frontend build', 'api endpoint', 'testing suite', 'deployment'][i],
    timestamp: now + i,
  });
}

function invoke(payload, env = {}) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'scripts/session-end-bookmark.mjs')], {
    input: JSON.stringify(payload),
    env: { ...process.env, MEMORY_DB: DB_PATH, ...env },
    encoding: 'utf8',
  });
}

await stage('bookmark row inserted with session_id + agent + directory', () => {
  const r = invoke({ session_id: 'hook-sess-1', agent: 'hook-test', cwd: '/tmp/some-dir' });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const row = getDb().prepare('SELECT * FROM session_bookmarks WHERE session_id = ?').get('hook-sess-1');
  assert.ok(row, 'bookmark row missing');
  assert.strictEqual(row.agent, 'hook-test');
  assert.strictEqual(row.directory, '/tmp/some-dir');
  assert.ok(row.ended_at, 'ended_at should be set');
});

await stage('WMEM_SKIP_KG=1 skips materialization', () => {
  // Wipe KG state first
  getDb().prepare('DELETE FROM kg_relations').run();
  const r = invoke({ session_id: 'hook-sess-skip', agent: 'hook-test', cwd: '/tmp/skip-dir' }, { WMEM_SKIP_KG: '1' });
  assert.strictEqual(r.status, 0);
  const count = getDb().prepare("SELECT COUNT(*) AS c FROM kg_relations").get().c;
  assert.strictEqual(count, 0, `expected 0 kg edges with WMEM_SKIP_KG=1, got ${count}`);
  // stderr should NOT contain 'kg:' line
  assert.ok(!r.stderr.includes('kg: topic_edges'), 'kg should be skipped');
});

await stage('default run materializes KG (topic + directory edges)', () => {
  getDb().prepare('DELETE FROM kg_relations').run();
  const r = invoke({ session_id: 'hook-sess-2', agent: 'hook-test', cwd: '/tmp/kg-dir' });
  assert.strictEqual(r.status, 0);
  // stderr should contain the kg: line with edge counts
  assert.ok(r.stderr.includes('kg: topic_edges'), `stderr missing kg log: ${r.stderr}`);
});

await stage('missing session_id: graceful skip exit 0', () => {
  const r = invoke({}); // no session_id anywhere
  assert.strictEqual(r.status, 0, 'should exit 0 even with no session_id');
  assert.ok(r.stderr.includes('no session_id'), 'should log the skip reason');
});

const failures = report.stages.filter(s => !s.ok);
console.log(`\nhooks-bookmark: ${report.stages.length - failures.length}/${report.stages.length} pass`);
process.exit(failures.length === 0 ? 0 : 1);
