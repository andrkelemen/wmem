#!/usr/bin/env node
/**
 * tests/kg-rebuild.test.mjs — the topic graph rebuild.
 *
 * Reported 2026-10-27, two faults in one function:
 *
 * 1. COST. It joined every chunk in a session to every other chunk in the same session,
 *    so the work grew with the SQUARE of the session size. On a 46.5k-chunk store with
 *    5,543 tagged chunks in one session it took 191 seconds; Claude Code kills an exit
 *    hook long before that. The pair count that join computed was never used — only
 *    COUNT(DISTINCT session_id) reached the insert — so the quadratic step existed
 *    entirely to produce a number that was discarded.
 *
 * 2. DESTRUCTION BEFORE THE RISK. The DELETE ran on its own, before the slow query and
 *    outside the insert transaction, so a kill between them committed the delete and
 *    never ran the inserts. Every killed session end left the topic graph EMPTY. A
 *    rebuild that can destroy and then fail to rebuild turns a timeout into data loss.
 *
 * The timing case below is the one that would have caught this before a user did. The
 * atomicity case is asserted structurally — an interrupt mid-transaction is not reachable
 * from inside the process being interrupted, and a test that claimed to simulate one
 * would be asserting better-sqlite3's rollback, not ours. Said plainly rather than dressed
 * up as coverage it does not have.
 */
import assert from 'node:assert/strict';
import { unlinkSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DB = '/tmp/wmem-kg-rebuild.db';
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if (existsSync(f)) unlinkSync(f);
process.env.MEMORY_DB = TEST_DB;

const _err = console.error;
console.error = (m, ...r) => {
  if (typeof m === 'string' && (m.startsWith('[wmem]') || m.startsWith('[db]') || m.startsWith('[migrate]'))) return;
  _err(m, ...r);
};

const db = await import('../core/db.mjs');
let passed = 0, failed = 0;
const cases = [];
const test = (n, f) => cases.push({ name: n, fn: f });

// Two sessions, each with many tagged chunks. The chunk count is what used to drive the
// cost; the tag count is what should drive it.
const d = db.getDb();
const CHUNKS_PER_SESSION = 500;
const TAGS = ['alpha', 'beta', 'gamma', 'delta'];
const insChunk = d.prepare(`INSERT INTO chunks (agent, source_type, source_id, session_id, content, timestamp)
                            VALUES ('t', 'conversation', ?, ?, ?, ?)`);
const insTag = d.prepare('INSERT INTO tags (chunk_id, tag) VALUES (?, ?)');
d.transaction(() => {
  for (const sid of ['s-one', 's-two']) {
    for (let i = 0; i < CHUNKS_PER_SESSION; i++) {
      const id = insChunk.run(`${sid}-${i}`, sid, `content ${i}`, Date.now()).lastInsertRowid;
      for (const t of TAGS) insTag.run(id, t);
    }
  }
})();

test('the rebuild does not join chunks to chunks', () => {
  // THE TIMING TEST BELOW CANNOT CATCH THIS, and saying so is the point. At a size a test
  // suite can afford — 1,000 chunks, 4 tags — the quadratic join still finishes in well
  // under the threshold; restoring it leaves every timing assertion green. The cost only
  // becomes visible on a real store, which is where the user found it and where a test
  // will never be. So assert the SHAPE, which is what actually regressed: pairing chunks
  // with chunks inside a session, to compute a count that was then discarded.
  const src = readFileSync(join(ROOT, 'core', 'db.mjs'), 'utf8');
  const start = src.indexOf('export function materializeTopicRelations(');
  const body = src.slice(start, src.indexOf('\n}', start));
  const sql = body.slice(body.indexOf('db.prepare(`'), body.indexOf('`).all()'));
  assert.ok(!/JOIN\s+chunks\s+\w+\s+ON[^)]*c1\.session_id/i.test(sql),
    'the chunk-to-chunk self-join is back: cost grows with the square of the session size');
  assert.ok(/DISTINCT/i.test(sql),
    'co-occurrence must be reduced to distinct (session, tag) pairs before being joined');
});

test('the rebuild finishes quickly at test size', () => {
  // A loose backstop, not the detector — see above. It catches something catastrophic,
  // such as a cross join with no session predicate at all.
  const t0 = Date.now();
  const res = db.materializeTopicRelations();
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `rebuild took ${ms}ms`);
  assert.ok(res.edges > 0, 'no edges produced');
});

test('co-occurrence is counted per session, not per chunk pair', () => {
  const rows = d.prepare(`SELECT source, target, session_count FROM kg_relations
                          WHERE source_type = 'topic' ORDER BY source, target`).all();
  // Four tags → six unordered pairs, each appearing in both sessions.
  assert.equal(rows.length, 6, `expected 6 topic edges, got ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.session_count, 2,
      `${r.source}/${r.target} counted ${r.session_count} — that is chunk pairs, not sessions`);
  }
});

test('a rebuild is idempotent', () => {
  const before = d.prepare("SELECT COUNT(*) c FROM kg_relations WHERE source_type = 'topic'").get().c;
  db.materializeTopicRelations();
  const after = d.prepare("SELECT COUNT(*) c FROM kg_relations WHERE source_type = 'topic'").get().c;
  assert.equal(after, before, 'rebuilding changed the edge count');
});

test('the clear happens INSIDE the rebuild transaction', () => {
  // Structural, and deliberately so — see the file header. What must never come back is a
  // DELETE that executes before the work it is clearing the way for.
  const src = readFileSync(join(ROOT, 'core', 'db.mjs'), 'utf8');
  for (const fn of ['materializeTopicRelations', 'materializeDirectoryRelations']) {
    const start = src.indexOf(`export function ${fn}(`);
    assert.ok(start > 0, `${fn} not found`);
    const body = src.slice(start, src.indexOf('\n}', start));
    const del = body.indexOf('DELETE FROM kg_relations');
    const tx = body.indexOf('db.transaction(');
    assert.ok(del > 0, `${fn}: no DELETE found`);
    assert.ok(tx > 0 && del > tx, `${fn}: the DELETE runs before the transaction — a kill between them empties the graph`);
  }
});

for (const { name, fn } of cases) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
