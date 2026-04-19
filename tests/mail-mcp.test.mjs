#!/usr/bin/env node
/*
  Functional test for the mail MCP surface. Exercises core/mail.mjs against the configured DB.
  Run from repo root:

    MEMORY_DB=/tmp/wmem-drill-mail.db node tests/mail-mcp.test.mjs

  If run against the prod DB, test-only agents prefixed 'test-mail-' are
  created + pruned at start and end of the run — prod data is not touched.

  Stages assert, they don't just record. Assertion discipline
  applied here too (assertion discipline).
*/

import {
  sendMessage, replyMessage, getInbox, getOutbox,
  getMessage, markRead, markUnread, threadMessages,
  countsByAgent, pendingForAgent,
} from '../core/mail.mjs';
import { upsertAgent } from '../core/agents.mjs';
import { getDb } from '../core/db.mjs';

const report = { stages: [], started: Date.now() };
let failed = 0;

function stage(name, fn) {
  const t0 = Date.now();
  try {
    const detail = fn();
    report.stages.push({ name, ok: true, ms: Date.now() - t0, detail });
  } catch (e) {
    report.stages.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const ALICE = 'test-mail-alice';
const BOB   = 'test-mail-bob';
const CAROL = 'test-mail-carol';

// Closure-scoped message ids, filled as stages run
let M1, M2, M3, M4;

// ─── setup ───────────────────────────────────────────────

stage('setup-cleanup-prev-run', () => {
  const db = getDb();
  const m = db.prepare(
    "DELETE FROM messages WHERE from_agent LIKE 'test-mail-%' OR to_agent LIKE 'test-mail-%'",
  ).run();
  const a = db.prepare("DELETE FROM agents WHERE id LIKE 'test-mail-%'").run();
  return { messages_cleared: m.changes, agents_cleared: a.changes };
});

stage('setup-seed-agents', () => {
  for (const id of [ALICE, BOB, CAROL]) {
    upsertAgent({ id, name: id });
  }
  const db = getDb();
  const count = db.prepare(
    "SELECT COUNT(*) AS c FROM agents WHERE id LIKE 'test-mail-%'",
  ).get().c;
  assert(count === 3, `seeded 3 agents, got ${count}`);
  return { count };
});

// ─── send / reply / thread ───────────────────────────────

stage('send-alice-to-bob', () => {
  const r = sendMessage({ from: ALICE, to: BOB, body: 'hello bob', subject: 'greeting' });
  assert(r.id > 0, 'id positive');
  assert(r.threadDepth === 0, `root thread_depth=0, got ${r.threadDepth}`);
  M1 = r.id;
  return r;
});

stage('send-with-metadata', () => {
  const r = sendMessage({
    from: ALICE, to: CAROL, body: 'note with meta',
    metadata: { source: 'mcp-tool', delivery_status: 'sent' },
  });
  assert(r.id > 0, 'id positive');
  const row = getMessage(r.id);
  assert(row.metadata.source === 'mcp-tool', 'metadata round-trip');
  return { id: r.id, metadata: row.metadata };
});

stage('reply-bob-to-alice', () => {
  const r = replyMessage({ from: BOB, parentId: M1, body: 'hi alice' });
  assert(r.to === ALICE, `reply-to resolved from parent.from, got ${r.to}`);
  assert(r.threadDepth === 1, `depth=1 for first reply, got ${r.threadDepth}`);
  M2 = r.id;
  return r;
});

stage('reply-alice-to-bob-depth2', () => {
  const r = replyMessage({ from: ALICE, parentId: M2, body: 're: hi' });
  assert(r.to === BOB, `chained reply-to resolved, got ${r.to}`);
  assert(r.threadDepth === 2, `depth=2 for nested reply, got ${r.threadDepth}`);
  M3 = r.id;
  return r;
});

stage('send-carol-to-bob-parallel-thread', () => {
  const r = sendMessage({ from: CAROL, to: BOB, body: 'hi bob from carol' });
  assert(r.threadDepth === 0, 'parallel thread is a new root');
  M4 = r.id;
  return r;
});

// ─── inbox / outbox / pending ────────────────────────────

stage('bob-inbox-contains-test-messages', () => {
  const msgs = getInbox(BOB, { limit: 200 });
  const toBob = msgs.filter((m) => [M1, M3, M4].includes(m.id));
  assert(toBob.length === 3, `3 test messages to bob, got ${toBob.length}`);
  return { total: msgs.length, from_test: toBob.length };
});

stage('bob-inbox-unread-only-filter', () => {
  const unread = getInbox(BOB, { unreadOnly: true, limit: 200 });
  const toBobUnread = unread.filter((m) => [M1, M3, M4].includes(m.id));
  assert(toBobUnread.length === 3, `all 3 test messages still unread, got ${toBobUnread.length}`);
  return { unread_from_test: toBobUnread.length };
});

stage('bob-pending-before-reads', () => {
  const r = pendingForAgent(BOB);
  assert(r.unread_count >= 3, `at least 3 unread, got ${r.unread_count}`);
  assert(r.oldest_ts > 0, 'oldest_ts is set');
  assert(
    r.oldest_from === ALICE || r.oldest_from === CAROL,
    `oldest_from is a test sender, got ${r.oldest_from}`,
  );
  return r;
});

stage('alice-outbox-contains-test-messages', () => {
  const rows = getOutbox(ALICE, { limit: 200 });
  const fromTest = rows.filter((r) => [M1, M3].includes(r.id));
  assert(fromTest.length === 2, `alice sent 2 from test (M1+M3), got ${fromTest.length}`);
  return { outbox_from_test: fromTest.length };
});

// ─── read / unread / idempotence ─────────────────────────

stage('mark-M1-read', () => {
  const r = markRead(M1);
  assert(r.marked === true, 'marked true on fresh unread');
  const row = getMessage(M1);
  assert(row.read === 1, 'row.read === 1 after mark');
  assert(row.read_at > 0, 'read_at timestamp set');
  return r;
});

stage('mark-M1-read-idempotent', () => {
  const r = markRead(M1);
  assert(r.marked === false, 'idempotent: second mark returns marked=false');
  return r;
});

stage('bob-pending-after-one-read', () => {
  const probe = pendingForAgent(BOB);
  const stillUnreadFromTest = getInbox(BOB, { unreadOnly: true, limit: 200 })
    .filter((m) => [M1, M3, M4].includes(m.id)).length;
  assert(stillUnreadFromTest === 2, `2 unread from test after M1 read, got ${stillUnreadFromTest}`);
  return { probe, unread_test: stillUnreadFromTest };
});

stage('mark-M1-unread', () => {
  const r = markUnread(M1);
  assert(r.marked === true, 'unmark succeeded');
  const row = getMessage(M1);
  assert(row.read === 0, 'row.read === 0 after unmark');
  assert(row.read_at === null, 'read_at cleared on unmark');
  return r;
});

// ─── thread walk + single fetch ──────────────────────────

stage('mail_thread-walks-root-to-leaves', () => {
  const rows = threadMessages(M3); // start from leaf, walk to root then expand
  const testIds = rows.map((r) => r.id).filter((id) => [M1, M2, M3].includes(id));
  assert(testIds.length === 3, `thread has M1+M2+M3, got ${testIds.length}`);
  assert(testIds[0] === M1, `root (M1) first, got ${testIds[0]}`);
  return { thread_size: rows.length, test_ids: testIds };
});

stage('mail_thread-from-root-same-result', () => {
  const rows = threadMessages(M1); // start from root
  const testIds = rows.map((r) => r.id).filter((id) => [M1, M2, M3].includes(id));
  assert(testIds.length === 3, 'root-start and leaf-start yield same thread');
  return { test_ids: testIds };
});

stage('get-message-by-id', () => {
  const row = getMessage(M2);
  assert(row !== null, 'found');
  assert(row.from_agent === BOB, `correct sender, got ${row.from_agent}`);
  assert(row.parent_id === M1, `correct parent, got ${row.parent_id}`);
  return { id: row.id, from: row.from_agent, parent: row.parent_id };
});

stage('get-message-not-found-returns-null', () => {
  const row = getMessage(999999999);
  assert(row === null, 'returns null for missing id');
  return { id: 999999999, result: row };
});

// ─── counts ──────────────────────────────────────────────

stage('counts-by-agent-includes-test-rows', () => {
  const rows = countsByAgent();
  const test = rows.filter((r) => r.agent_id?.startsWith('test-mail-'));
  assert(test.length === 3, `3 test agents in counts, got ${test.length}`);
  const bob = test.find((r) => r.agent_id === BOB);
  assert(bob.inbox_total >= 3, `bob inbox_total >= 3, got ${bob.inbox_total}`);
  const alice = test.find((r) => r.agent_id === ALICE);
  assert(alice.outbox_total >= 2, `alice outbox_total >= 2, got ${alice.outbox_total}`);
  return { test_agents_in_counts: test.length };
});

// ─── spoof-impossibility (core-layer validation) ─────────

stage('send-unknown-to_agent-rejected', () => {
  let threw = false;
  try {
    sendMessage({ from: ALICE, to: 'ghost-never-seeded', body: 'boo' });
  } catch (e) { threw = true; }
  assert(threw, 'unknown recipient throws');
  return { rejected: true };
});

stage('reply-unknown-parent-rejected', () => {
  let threw = false;
  try {
    replyMessage({ from: ALICE, parentId: 999999999, body: 'reply to nothing' });
  } catch (e) { threw = true; }
  assert(threw, 'unknown parent throws');
  return { rejected: true };
});

// ─── mock supervisor-consumer I/O pattern (pluggability contract) ────────
// Demonstrates the pull pattern a supervisor would use to consume mail.
// No sv needed — this IS the sv integration contract for the mail surface.
// Plug sv on later: it does exactly what these stages do.

stage('sv-poll-pattern-cheap-probe', () => {
  const probe = pendingForAgent(BOB);
  return { unread_count: probe.unread_count, should_fetch: probe.unread_count > 0 };
});

stage('sv-poll-pattern-conditional-fetch-and-mark', () => {
  // Step 1: cheap probe
  const probe = pendingForAgent(BOB);
  if (probe.unread_count === 0) return { action: 'noop', probe };

  // Step 2: conditional inbox fetch (only when non-zero)
  const messages = getInbox(BOB, { unreadOnly: true, limit: 50 });

  // Step 3: process + mark read (simulated sv consumer)
  const processed = messages
    .filter((m) => [M1, M3, M4].includes(m.id))
    .map((m) => {
      markRead(m.id);
      return { id: m.id, from: m.from_agent };
    });

  assert(processed.length >= 1, 'at least one test message processed');
  return { probe, fetched_total: messages.length, processed_from_test: processed };
});

stage('sv-poll-pattern-drain-verified', () => {
  const stillUnreadTest = getInbox(BOB, { unreadOnly: true, limit: 200 })
    .filter((m) => [M1, M3, M4].includes(m.id)).length;
  assert(stillUnreadTest === 0, `test inbox drained, got ${stillUnreadTest} unread`);
  return { drained: true };
});

// ─── cleanup ─────────────────────────────────────────────

stage('cleanup-test-rows', () => {
  const db = getDb();
  const m = db.prepare(
    "DELETE FROM messages WHERE from_agent LIKE 'test-mail-%' OR to_agent LIKE 'test-mail-%'",
  ).run();
  const a = db.prepare("DELETE FROM agents WHERE id LIKE 'test-mail-%'").run();
  return { messages_deleted: m.changes, agents_deleted: a.changes };
});

// ─── report ──────────────────────────────────────────────

report.finished = Date.now();
report.total_ms = report.finished - report.started;
report.pass = report.stages.filter((s) => s.ok).length;
report.fail = report.stages.filter((s) => !s.ok).length;
report.total = report.stages.length;

console.log(JSON.stringify(report, null, 2));
process.exit(failed === 0 ? 0 : 1);
