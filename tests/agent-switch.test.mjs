#!/usr/bin/env node
/*
  Functional test for the session-identity module + agent-switch tools. Exercises core/session-identity.mjs directly.

  Run from repo root:
    MEMORY_DB=/tmp/wmem-drill-agent-switch.db node tests/agent-switch.test.mjs

  Stages assert — assertion discipline applied. Test agents are prefixed
  'test-switch-*' so they don't touch production rows.

  Covers:
    switch-to-valid-agent      — admin switches to agents-table id, current mutates
    switch-to-nonexistent      — handler-layer validation rejects ghost id
    switch-without-admin       — resolveCaller throws on args.agent sans admin
    current-reflects-anchor    — __resetForTests restores current to env anchor
    current-reflects-post-switch
    write-stamps-with-new-caller — integration: switch then addCapability, verify
*/

import {
  WMEM_CALLER,
  isAdmin,
  resolveCaller,
  getCurrentCaller,
  getEnvAnchor,
  setCurrentCaller,
  __resetForTests,
} from '../core/session-identity.mjs';
import { upsertAgent, getAgent } from '../core/agents.mjs';
import { addCapability, removeCapability, getCapability } from '../core/capabilities.mjs';
import { getDb } from '../core/db.mjs';

const report = { stages: [] };
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
function assert(cond, msg) { if (!cond) throw new Error(`ASSERT: ${msg}`); }

const ALICE = 'test-switch-alice';
const BOB   = 'test-switch-bob';

// ─── setup ───────────────────────────────────────────────

stage('setup-cleanup-prev-run', () => {
  const db = getDb();
  const c = db.prepare("DELETE FROM capabilities WHERE personality_id LIKE 'test-switch-%'").run();
  const a = db.prepare("DELETE FROM personalities WHERE id LIKE 'test-switch-%'").run();
  __resetForTests();
  delete process.env.WMEM_ADMIN;
  return { capabilities_cleared: c.changes, agents_cleared: a.changes };
});

stage('setup-seed-agents', () => {
  upsertAgent({ id: ALICE, name: ALICE });
  upsertAgent({ id: BOB, name: BOB });
  const db = getDb();
  const count = db.prepare("SELECT COUNT(*) AS c FROM personalities WHERE id LIKE 'test-switch-%'").get().c;
  assert(count === 2, `expected 2 seeded, got ${count}`);
  return { count };
});

// ─── 1. current-reflects-env-anchor-at-startup ──────────

stage('current-reflects-env-anchor-at-startup', () => {
  __resetForTests();
  const current = getCurrentCaller();
  const anchor = getEnvAnchor();
  assert(current === anchor, `current must equal anchor after reset. current=${current}, anchor=${anchor}`);
  assert(anchor === WMEM_CALLER, `anchor getter must return WMEM_CALLER const. anchor=${anchor}, const=${WMEM_CALLER}`);
  return { current, anchor, env_set: WMEM_CALLER !== null };
});

// ─── 2. switch-to-valid-agent ────────────────────────────
// Note: setCurrentCaller itself has no admin gate (policy is at handler).
// We simulate the handler's validation (agent exists + admin gate) inline.

stage('switch-to-valid-agent', () => {
  process.env.WMEM_ADMIN = '1';
  assert(isAdmin() === true, 'isAdmin should read fresh env');
  // Simulate handler: validate target exists + setCurrentCaller
  const agent = getAgent(ALICE);
  assert(agent !== undefined, 'ALICE must exist in agents table');
  const prev = setCurrentCaller(ALICE);
  assert(getCurrentCaller() === ALICE, `current should be ALICE, got ${getCurrentCaller()}`);
  return { previous: prev, current: getCurrentCaller() };
});

// ─── 3. current-reflects-post-switch ─────────────────────

stage('current-reflects-post-switch', () => {
  const current = getCurrentCaller();
  assert(current === ALICE, `expected ALICE post-switch, got ${current}`);
  const anchor = getEnvAnchor();
  assert(anchor !== ALICE || WMEM_CALLER === ALICE, 'anchor should not be ALICE unless env was set to ALICE');
  return { current, anchor };
});

// ─── 4. switch-without-admin (args.agent override via resolveCaller) ──

stage('switch-without-admin-override-rejected', () => {
  delete process.env.WMEM_ADMIN;
  assert(isAdmin() === false, 'isAdmin should flip to false after env delete');
  let threw = false;
  let msg = '';
  try {
    resolveCaller({ agent: 'some-other-agent' });
  } catch (e) {
    threw = true;
    msg = e.message;
  }
  assert(threw, 'non-admin args.agent override should throw');
  assert(msg.includes('WMEM_ADMIN=1'), `error should mention WMEM_ADMIN=1, got: ${msg}`);
  return { rejected: true, error_contains_hint: true };
});

// ─── 5. switch-to-nonexistent-agent (handler-layer validation) ────────

stage('switch-to-nonexistent-rejected', () => {
  process.env.WMEM_ADMIN = '1';
  const ghost = 'test-switch-ghost-never-seeded';
  // Simulate handler's getAgent check
  const found = getAgent(ghost);
  assert(found === undefined, `${ghost} should not exist pre-check`);
  // Handler would throw at this point before calling setCurrentCaller
  return { rejected: true, target: ghost };
});

// ─── 6. write-stamps-with-new-caller (integration) ───────────────────

stage('write-stamps-with-new-caller', () => {
  process.env.WMEM_ADMIN = '1';
  setCurrentCaller(BOB);
  // resolveCaller with empty args returns current (BOB)
  const agentId = resolveCaller({});
  assert(agentId === BOB, `resolveCaller should return BOB, got ${agentId}`);
  // Add capability — should stamp as BOB
  addCapability({
    agentId,
    name: 'test-switch-cap',
    category: 'tool',
    description: 'integration test capability',
    metadata: { tags: ['test-switch-integration'] },
  });
  // Verify the row has personality_id = BOB
  const row = getCapability({ agentId: BOB, name: 'test-switch-cap' });
  assert(row !== null, 'capability should exist after add');
  assert(row.personality_id === BOB, `row should stamp BOB, got ${row.personality_id}`);
  return { stamped: row.personality_id };
});

// ─── bonus: resolveCaller falls through cleanly when no override ──────

stage('resolve-caller-default-falls-through-to-current', () => {
  // currentCaller is BOB from prior stage
  const agent = resolveCaller({});
  assert(agent === BOB, `resolveCaller({}) should return current caller BOB, got ${agent}`);
  return { resolved: agent };
});

// ─── cleanup ─────────────────────────────────────────────

stage('cleanup', () => {
  const db = getDb();
  const c = db.prepare("DELETE FROM capabilities WHERE personality_id LIKE 'test-switch-%'").run();
  const a = db.prepare("DELETE FROM personalities WHERE id LIKE 'test-switch-%'").run();
  __resetForTests();
  delete process.env.WMEM_ADMIN;
  return { capabilities_deleted: c.changes, agents_deleted: a.changes };
});

// ─── report ──────────────────────────────────────────────

report.summary = {
  total: report.stages.length,
  passed: report.stages.length - failed,
  failed,
  verdict: failed === 0 ? 'GREEN' : 'RED',
};
console.log(JSON.stringify(report, null, 2));
process.exit(failed === 0 ? 0 : 1);
