#!/usr/bin/env node
/**
 * tests/agents.test.mjs — validates the agent/preference/facts pipeline.
 *
 * Run: node tests/agents.test.mjs
 * Uses a throwaway DB at /tmp/wmem-agents-test.db so real DBs aren't touched.
 */

import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';

const TEST_DB = '/tmp/wmem-agents-test.db';
if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
process.env.MEMORY_DB = TEST_DB;

// Silence info logs
const _err = console.error;
console.error = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[wmem]') || msg.startsWith('[db]') || msg.startsWith('[migrate]'))) return;
  _err(msg, ...rest);
};

const agents = await import('../core/agents.mjs');
const db = await import('../core/db.mjs');

let passed = 0;
let failed = 0;
const cases = [];

function test(name, fn) {
  cases.push({ name, fn });
}

async function run() {
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).map(l => '    ' + l).join('\n'));
      failed++;
    }
  }
}

// ───────────────────────────────────────────────────────────
// MIGRATIONS
// ───────────────────────────────────────────────────────────

test('migration runner applies all pending migrations on fresh DB', () => {
  const d = db.getDb();
  const applied = d.prepare('SELECT filename FROM schema_migrations ORDER BY filename').all();
  assert.deepEqual(applied.map(r => r.filename), [
    '0000_schema_migrations.sql',
    '0001_agent_tables.sql',
    '0002_preference_anchors.sql',
    '0003_project_scopes_and_session_files.sql',
  ]);
});

test('fresh DB has 6 seeded agents from built-in templates', () => {
  const list = agents.listAgents();
  assert.equal(list.length, 6);
  const ids = list.map(a => a.id).sort();
  assert.deepEqual(ids, ['architect', 'coder', 'confidant', 'researcher', 'reviewer', 'writer']);
});

// ───────────────────────────────────────────────────────────
// AGENTS
// ───────────────────────────────────────────────────────────

test('upsertAgent creates a new agent', () => {
  const res = agents.upsertAgent({ id: 'custom-1', name: 'Custom One', role: 'custom' });
  assert.equal(res.created, true);
  const got = agents.getAgent('custom-1');
  assert.equal(got.name, 'Custom One');
});

test('upsertAgent updates an existing agent', () => {
  agents.upsertAgent({ id: 'custom-1', name: 'Custom Renamed', role: 'custom' });
  const got = agents.getAgent('custom-1');
  assert.equal(got.name, 'Custom Renamed');
});

// ───────────────────────────────────────────────────────────
// PREFERENCES
// ───────────────────────────────────────────────────────────

test('writePreference creates a standalone preference', () => {
  const r = agents.writePreference({
    agentId: 'coder', key: 'indent_style', value: 'spaces',
    signalStrength: 0.9, signalType: 'liked',
  });
  assert.ok(r.id > 0);
  assert.deepEqual(r.relations, []);
});

test('writePreference creates a multi-target relational preference', () => {
  const r = agents.writePreference({
    agentId: 'architect', key: 'review_style', value: 'thorough',
    signalStrength: 0.8, signalType: 'liked',
    relations: ['coder', 'reviewer'],
  });
  assert.deepEqual(r.relations.sort(), ['coder', 'reviewer']);
});

test('writePreference silently drops unknown agent ids from relations', () => {
  const r = agents.writePreference({
    agentId: 'architect', key: 'pair_with', relations: ['coder', 'bogus_agent'],
  });
  assert.deepEqual(r.relations, ['coder']);
});

test('writePreference throws on unknown subject agent', () => {
  assert.throws(
    () => agents.writePreference({ agentId: 'nobody_here', key: 'x' }),
    /unknown agent: nobody_here/,
  );
});

test('listPreferences filters by agentId', () => {
  const prefs = agents.listPreferences({ agentId: 'architect' });
  assert.ok(prefs.length >= 2);
  for (const p of prefs) assert.equal(p.agent_id, 'architect');
});

test('listPreferences filters by objectAgentId via relations join', () => {
  const prefs = agents.listPreferences({ objectAgentId: 'coder' });
  assert.ok(prefs.length >= 2);
  for (const p of prefs) assert.ok(p.relations.includes('coder'));
});

test('listPreferences returns relations and parsed metadata', () => {
  agents.writePreference({
    agentId: 'coder', key: 'theme', value: 'dark',
    metadata: { source: 'test' }, relations: ['reviewer'],
  });
  const prefs = agents.listPreferences({ agentId: 'coder', key: 'theme' });
  assert.equal(prefs[0].metadata.source, 'test');
  assert.deepEqual(prefs[0].relations, ['reviewer']);
});

// ───────────────────────────────────────────────────────────
// FACTS
// ───────────────────────────────────────────────────────────

test('writeFact + listFacts', () => {
  agents.writeFact({ agentId: 'coder', category: 'voice', fact: 'terse by default', confidence: 0.75 });
  agents.writeFact({ agentId: 'coder', category: 'behavior', fact: 'ships small PRs', confidence: 0.85 });
  const facts = agents.listFacts({ agentId: 'coder' });
  assert.ok(facts.length >= 2);
  // higher confidence first
  assert.ok(facts[0].confidence >= facts[1].confidence);
});

test('facts_list filters by category', () => {
  const voice = agents.listFacts({ agentId: 'coder', category: 'voice' });
  for (const f of voice) assert.equal(f.category, 'voice');
});

// ───────────────────────────────────────────────────────────
// REVIEW QUEUE
// ───────────────────────────────────────────────────────────

test('enqueueReview adds to queue, listPendingReviews returns it', () => {
  agents.enqueueReview({ sessionId: 'sess-A', agentId: 'coder', chunkCount: 10 });
  const pending = agents.listPendingReviews();
  assert.ok(pending.some(p => p.session_id === 'sess-A'));
});

test('enqueueReview is idempotent on session_id (no duplicates)', () => {
  agents.enqueueReview({ sessionId: 'sess-A', agentId: 'coder', chunkCount: 20 });
  const pending = agents.listPendingReviews();
  const matches = pending.filter(p => p.session_id === 'sess-A');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].chunk_count, 20); // updated
});

test('claimReview is atomic — second claim on same session returns null', () => {
  agents.enqueueReview({ sessionId: 'sess-B', agentId: 'architect' });
  const first = agents.claimReview('sess-B', 'coder');
  assert.ok(first);
  assert.equal(first.claimed_by, 'coder');
  const second = agents.claimReview('sess-B', 'reviewer');
  assert.equal(second, null);
});

test('completeReview removes the row', () => {
  agents.enqueueReview({ sessionId: 'sess-C', agentId: 'coder' });
  const before = agents.listPendingReviews({ unclaimedOnly: false }).filter(p => p.session_id === 'sess-C').length;
  assert.equal(before, 1);
  agents.completeReview('sess-C');
  const after = agents.listPendingReviews({ unclaimedOnly: false }).filter(p => p.session_id === 'sess-C').length;
  assert.equal(after, 0);
});

test('listPendingReviews unclaimedOnly excludes claimed tasks', () => {
  agents.enqueueReview({ sessionId: 'sess-D' });
  agents.enqueueReview({ sessionId: 'sess-E' });
  agents.claimReview('sess-D', 'coder');
  const unclaimed = agents.listPendingReviews({ unclaimedOnly: true });
  const ids = unclaimed.map(p => p.session_id);
  assert.ok(ids.includes('sess-E'));
  assert.ok(!ids.includes('sess-D'));
});

// ───────────────────────────────────────────────────────────
// PREFERENCE ANCHORS (migration 0002)
// ───────────────────────────────────────────────────────────

test('preference_anchors table exists from migration 0002', () => {
  const d = db.getDb();
  const row = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='preference_anchors'").get();
  assert.ok(row);
});

test('writeAnchor attaches evidence to a preference', () => {
  const pref = agents.writePreference({ agentId: 'coder', key: 'editor', value: 'neovim', signalStrength: 0.9 });
  const a = agents.writeAnchor({ preferenceId: pref.id, valence: 'reinforces', annotation: 'said it twice in standup' });
  assert.ok(a.id > 0);
});

test('writeAnchor rejects unknown preference_id', () => {
  assert.throws(
    () => agents.writeAnchor({ preferenceId: 999999, valence: 'reinforces' }),
    /unknown preference_id/,
  );
});

test('writeAnchor rejects invalid valence', () => {
  const pref = agents.writePreference({ agentId: 'coder', key: 'x', value: 'y' });
  assert.throws(
    () => agents.writeAnchor({ preferenceId: pref.id, valence: 'enforces' }),
    /invalid valence/,
  );
});

test('listAnchors returns newest-first by default', () => {
  const pref = agents.writePreference({ agentId: 'coder', key: 'anchor_test', value: 't' });
  agents.writeAnchor({ preferenceId: pref.id, valence: 'reinforces', annotation: 'first' });
  agents.writeAnchor({ preferenceId: pref.id, valence: 'refines', annotation: 'second' });
  agents.writeAnchor({ preferenceId: pref.id, valence: 'contradicts', annotation: 'third' });
  const anchors = agents.listAnchors({ preferenceId: pref.id });
  assert.equal(anchors.length, 3);
  assert.equal(anchors[0].annotation, 'third');
  assert.equal(anchors[2].annotation, 'first');
});

test('listPreferences includeAnchors inlines top-N anchors', () => {
  const pref = agents.writePreference({ agentId: 'coder', key: 'inline_anchor_test', value: 'v' });
  for (let i = 0; i < 7; i++) {
    agents.writeAnchor({ preferenceId: pref.id, valence: 'reinforces', annotation: `a${i}` });
  }
  const [row] = agents.listPreferences({ agentId: 'coder', key: 'inline_anchor_test', includeAnchors: true, anchorLimit: 3 });
  assert.ok(Array.isArray(row.anchors));
  assert.equal(row.anchors.length, 3);
});

test('listPreferences without includeAnchors omits the anchors field', () => {
  const [row] = agents.listPreferences({ agentId: 'coder', key: 'inline_anchor_test' });
  assert.equal(row.anchors, undefined);
});

test('anchors cascade-delete when preference is removed', () => {
  const pref = agents.writePreference({ agentId: 'coder', key: 'cascade_test', value: 'v' });
  agents.writeAnchor({ preferenceId: pref.id, valence: 'reinforces' });
  agents.writeAnchor({ preferenceId: pref.id, valence: 'refines' });
  const d = db.getDb();
  d.prepare('DELETE FROM agent_preferences WHERE id = ?').run(pref.id);
  const remaining = d.prepare('SELECT COUNT(*) c FROM preference_anchors WHERE preference_id = ?').get(pref.id);
  assert.equal(remaining.c, 0);
});

// ───────────────────────────────────────────────────────────
// IDEMPOTENCY
// ───────────────────────────────────────────────────────────

test('migration runner re-run is a no-op (same migrations, no duplicate seed)', async () => {
  const { runMigrations } = await import('../migrations/_runner.mjs');
  const d = db.getDb();
  const before = agents.listAgents().length;
  runMigrations(d, { quiet: true });
  const after = agents.listAgents().length;
  assert.equal(before, after);
});

// ───────────────────────────────────────────────────────────

await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
