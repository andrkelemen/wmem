#!/usr/bin/env node
/**
 * tests/personality-id.test.mjs — a created personality must be USABLE.
 *
 * Reported 2026-10-27. `personalities.id` is `TEXT PRIMARY KEY` after migration 0006, and
 * SQLite permits NULL in a non-INTEGER primary key, so `createPersonality` — which never
 * inserted an id — produced rows that looked created and were not usable: absent from
 * agents_list, and rejected as the target of personality_preferences, personality_facts
 * and the switch audit, all of which are foreign keys onto that column.
 *
 * The symptom was `preferences_write(agent_id: "<name>")` failing with "unknown agent"
 * while `memory_ingest` accepted the same name, because `chunks.agent` is free text with
 * no foreign key. Only the six built-ins worked, because 0001 seeds them WITH an id.
 *
 * "It was created" is not the assertion. The assertion is that the next call works, which
 * is the only question a user ever asks. Every case here was checked red against the
 * pre-fix insert.
 */
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';

const TEST_DB = '/tmp/wmem-personality-id-test.db';
for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) if (existsSync(f)) unlinkSync(f);
process.env.MEMORY_DB = TEST_DB;

const _err = console.error;
console.error = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[wmem]') || msg.startsWith('[db]') || msg.startsWith('[migrate]'))) return;
  _err(msg, ...rest);
};

const personality = await import('../core/personality.mjs');
const agents = await import('../core/agents.mjs');
const db = await import('../core/db.mjs');

let passed = 0, failed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('createPersonality writes an id', () => {
  const res = personality.createPersonality({ name: 'TestBot', description: 'a created personality' });
  assert.equal(res.created, true);
  const row = db.getDb().prepare('SELECT id, name FROM personalities WHERE name = ?').get('TestBot');
  assert.ok(row, 'row not inserted');
  assert.notEqual(row.id, null, 'id is NULL — the row exists and cannot be used');
  assert.equal(row.id, 'testbot', 'id should be the canonical form of the name, as the built-ins are');
});

test('a created personality can be written to — the whole point', () => {
  const r = agents.writePreference({
    agentId: 'testbot', key: 'tabs_or_spaces', value: 'spaces',
    signalStrength: 0.8, signalType: 'liked',
  });
  assert.ok(r.id > 0, 'preference not written');
});

test('a created personality is listed', () => {
  const found = agents.listAgents().some(a => a.id === 'testbot');
  assert.ok(found, 'created personality missing from listAgents');
});

test('NULL ids already in a store are repaired, not left behind', () => {
  const d = db.getDb();
  // Exactly the row the old insert produced.
  d.prepare(`INSERT INTO personalities (name, display_name, created_at, updated_at)
             VALUES ('Legacy', 'Legacy', ?, ?)`).run(Date.now(), Date.now());
  assert.equal(d.prepare("SELECT id FROM personalities WHERE name = 'Legacy'").get().id, null);

  // The repair stamps itself, so re-running needs the stamp cleared — that IS the
  // once-only behaviour being asserted, not a way around it.
  d.prepare("DELETE FROM schema_migrations WHERE filename = '0012_personality_null_ids.code'").run();
  const res = db.repairNullPersonalityIds(d);
  assert.deepEqual(res.repaired, ['legacy']);
  assert.equal(d.prepare("SELECT id FROM personalities WHERE name = 'Legacy'").get().id, 'legacy');
});

test('a repair that would collide is refused, not merged', () => {
  const d = db.getDb();
  d.prepare(`INSERT INTO personalities (name, display_name, created_at, updated_at)
             VALUES ('TESTBOT', 'Testbot Again', ?, ?)`).run(Date.now(), Date.now());
  d.prepare("DELETE FROM schema_migrations WHERE filename = '0012_personality_null_ids.code'").run();
  const res = db.repairNullPersonalityIds(d);
  assert.deepEqual(res.repaired, [], 'it should not have claimed a repair');
  assert.equal(res.refused.length, 1);
  assert.equal(res.refused[0].id, 'testbot');
  assert.equal(d.prepare("SELECT id FROM personalities WHERE name = 'TESTBOT'").get().id, null,
    'the colliding row must be left alone for a person to decide');
});

test('the repair runs once', () => {
  const d = db.getDb();
  assert.equal(db.repairNullPersonalityIds(d), null, 'it ran twice');
});

for (const { name, fn } of cases) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
