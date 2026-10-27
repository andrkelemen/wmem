#!/usr/bin/env node
/**
 * tests/session-end-agent.test.mjs — SessionEnd must file under the ACTIVE personality.
 *
 * Reported 2026-10-27. `session-start.mjs` resolved the active personality;
 * `session-end.mjs` read `cfg.agent || 'default'`. With WMEM_AGENT unset — the normal
 * case — every session end filed its bookmark, its preference-queue row and the tail of
 * its index under `default`. The visible symptom was `memory_last_session` answering
 * "No session bookmarks found" for the real personality while hundreds of bookmarks sat
 * under `default`, going back months.
 *
 * TWO COPIES OF ONE DECISION, which is the same defect as the three database defaults:
 * the fix is not to correct the second copy, it is to stop there being a second copy. So
 * the assertion that matters is not "session-end resolves correctly" but "both hooks
 * resolve the SAME", which is the thing that cannot drift.
 */
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DB = '/tmp/wmem-session-end-agent.db';
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if (existsSync(f)) unlinkSync(f);
process.env.MEMORY_DB = TEST_DB;
delete process.env.WMEM_AGENT;

const _err = console.error;
console.error = (m, ...r) => {
  if (typeof m === 'string' && (m.startsWith('[wmem]') || m.startsWith('[db]') || m.startsWith('[migrate]'))) return;
  _err(m, ...r);
};

const personality = await import('../core/personality.mjs');
const db = await import('../core/db.mjs');
const doctor = await import('../core/doctor.mjs');

let passed = 0, failed = 0;
const cases = [];
const test = (n, f) => cases.push({ name: n, fn: f });

personality.createPersonality({ name: 'chris', description: 'the reporter' });
personality.activatePersonality('chris');

test('resolveAgent returns the active personality, not "default"', async () => {
  const lib = await import('../scripts/hooks/lib.mjs');
  const agent = await lib.resolveAgent();
  assert.equal(agent, 'chris');
});

test('both session hooks resolve through the same function', () => {
  // The guard against the two copies coming back. Grep is the right instrument here:
  // the defect was a second literal in a second file, and that is what must not return.
  const start = execFileSync('grep', ['-c', 'resolveAgent', join(ROOT, 'scripts/hooks/session-start.mjs')], { encoding: 'utf8' }).trim();
  const end = execFileSync('grep', ['-c', 'resolveAgent', join(ROOT, 'scripts/hooks/session-end.mjs')], { encoding: 'utf8' }).trim();
  assert.ok(Number(start) > 0, 'session-start does not use resolveAgent');
  assert.ok(Number(end) > 0, 'session-end does not use resolveAgent');
  for (const f of ['session-start.mjs', 'session-end.mjs']) {
    let hits = '';
    try {
      hits = execFileSync('grep', ['-n', "|| 'default'", join(ROOT, 'scripts/hooks', f)], { encoding: 'utf8' });
    } catch { hits = ''; }
    assert.equal(hits.trim(), '', `${f} still carries its own 'default' fallback: ${hits}`);
  }
});

test('a bookmark written at session end lands under the personality', () => {
  const d = db.getDb();
  db.upsertBookmark({ sessionId: 'sess-1', agent: 'chris', summary: 'ended', endedAt: Date.now() });
  const row = d.prepare('SELECT agent FROM session_bookmarks WHERE session_id = ?').get('sess-1');
  assert.equal(row.agent, 'chris');
  const last = db.getLastSession('chris');
  assert.ok(last, 'memory_last_session found nothing for the personality');
});

test('rows already filed under default are found', () => {
  const d = db.getDb();
  db.upsertBookmark({ sessionId: 'sess-old', agent: 'default', summary: 'misfiled', endedAt: Date.now() });
  const m = doctor.findMisfiledDefault();
  assert.ok(m.total >= 1, 'detector found nothing');
  assert.equal(m.counts['session_bookmarks.agent'], 1);
  assert.equal(m.target, 'chris', 'should target the active personality');
});

test('adoption previews before it moves', () => {
  const res = doctor.adoptDefaultRows({ dryRun: true });
  assert.equal(res.moved, 0);
  assert.ok(res.wouldMove >= 1);
  assert.equal(res.target, 'chris');
  const d = db.getDb();
  assert.equal(d.prepare("SELECT COUNT(*) c FROM session_bookmarks WHERE agent = 'default'").get().c, 1,
    'a dry run moved rows');
});

test('adoption moves them when told to', () => {
  const res = doctor.adoptDefaultRows({ dryRun: false });
  assert.ok(res.moved >= 1);
  const d = db.getDb();
  assert.equal(d.prepare("SELECT COUNT(*) c FROM session_bookmarks WHERE agent = 'default'").get().c, 0);
  assert.equal(d.prepare("SELECT agent FROM session_bookmarks WHERE session_id = 'sess-old'").get().agent, 'chris');
});

test('adoption refuses to guess between several personalities', () => {
  const d = db.getDb();
  personality.createPersonality({ name: 'other', description: 'second' });
  d.prepare('UPDATE personalities SET active = 0').run();        // none active
  db.upsertBookmark({ sessionId: 'sess-amb', agent: 'default', summary: 'x', endedAt: Date.now() });
  const res = doctor.adoptDefaultRows({ dryRun: false });
  assert.equal(res.refused, true, 'it picked one');
  assert.equal(d.prepare("SELECT agent FROM session_bookmarks WHERE session_id = 'sess-amb'").get().agent, 'default');
});

for (const { name, fn } of cases) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
