#!/usr/bin/env node
/*
  Capabilities registry functional test. Exercises core/capabilities.mjs
  directly against the configured DB. Run from repo root with MEMORY_DB
  pointed at a drill database so we don't touch production.

    MEMORY_DB=/tmp/wmem-drill-capabilities.db node tests/capabilities.test.mjs

  Stages assert, they don't just record — stages that return empty rows on
  a keyword that SHOULD have matches are false-green otherwise.
*/
import {
  addCapability, updateCapability, removeCapability,
  getCapability, listCapabilities,
  lookupCapabilities, matchCapabilities, verifyCapability,
} from "../core/capabilities.mjs";
import { upsertAgent } from "../core/agents.mjs";
import { getDb } from "../core/db.mjs";

const ALICE = 'test-cap-alice';
const BOB   = 'test-cap-bob';
const CAROL = 'test-cap-carol';

const report = { stages: [] };
function stage(name, fn) {
  const t0 = Date.now();
  try {
    const detail = fn();
    report.stages.push({ name, ok: true, ms: Date.now() - t0, detail });
  } catch (e) {
    report.stages.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// setup — scope to test agents, cleanup any prior run
stage('setup-cleanup', () => {
  const db = getDb();
  db.prepare("DELETE FROM capabilities WHERE agent_id LIKE 'test-cap-%'").run();
  db.prepare("DELETE FROM agents WHERE id LIKE 'test-cap-%'").run();
  return { cleaned: true };
});

stage('setup-seed-agents', () => {
  for (const id of [ALICE, BOB, CAROL]) upsertAgent({ id, name: id });
  return { seeded: 3 };
});

// 1. add capabilities across agents + categories + tiers
stage('add-alice-gpu-primary', () => addCapability({
  agentId: ALICE, name: 'gpu-primary', category: 'hardware',
  description: 'High-VRAM GPU for image generation workloads',
  tier: 'primary',
  requires: { vram_gb: 24 },
  metadata: { tags: ['gpu', 'inference', 'image-gen'] },
}));

stage('add-bob-api-imagegen', () => addCapability({
  agentId: BOB, name: 'api-imagegen', category: 'tool',
  description: 'External API image generation — cloud fallback',
  tier: 'primary',
  requires: { env: 'API_KEY', network: 'external' },
  metadata: { tags: ['image-gen', 'api', 'cloud'] },
}));

stage('add-bob-gpu-fallback', () => addCapability({
  agentId: BOB, name: 'gpu-fallback', category: 'hardware',
  description: 'Local smaller GPU for light inference',
  tier: 'fallback',
  metadata: { tags: ['gpu', 'inference', 'local'] },
}));

stage('add-carol-iot', () => addCapability({
  agentId: CAROL, name: 'iot-switch', category: 'hardware',
  description: 'Smart plug controlling desk outlet',
  location: 'ha:switch.desk_outlet',
  tier: 'primary',
  metadata: { tags: ['iot', 'switch', 'home-automation'] },
}));

stage('add-carol-tts', () => addCapability({
  agentId: CAROL, name: 'local-tts', category: 'io',
  description: 'Local text-to-speech synthesis with offline voice model',
  tier: 'primary',
  metadata: { tags: ['voice', 'tts', 'offline', 'synthesis'] },
}));

// 2. verify + update
stage('verify-alice-gpu', () => verifyCapability({ agentId: ALICE, name: 'gpu-primary' }));
stage('update-bob-api-version', () => updateCapability({
  agentId: BOB, name: 'api-imagegen', fields: { version: '1.1.0' },
}));

// 3. get single
stage('get-carol-iot', () => getCapability({ agentId: CAROL, name: 'iot-switch' }));

// 4. list — total, per-agent, per-category
stage('list-test-scope', () => {
  const r = listCapabilities({}).filter((c) => c.agent_id?.startsWith('test-cap-'));
  assert(r.length === 5, `expected 5 test capabilities, got ${r.length}`);
  return { count: r.length };
});
stage('list-carol-only', () => {
  const r = listCapabilities({ agent: CAROL });
  assert(r.length === 2, `carol should have 2 caps (iot + tts), got ${r.length}`);
  return { count: r.length };
});
stage('list-hardware', () => {
  const r = listCapabilities({ category: 'hardware' }).filter((c) => c.agent_id?.startsWith('test-cap-'));
  assert(r.length === 3, `expected 3 hardware caps in test scope, got ${r.length}`);
  return { count: r.length };
});

// 5. lookup keyword — assertions on count + tier ordering
stage('lookup-image-gen', () => {
  const r = lookupCapabilities({ query: 'image generation' }).filter((c) => c.agent_id?.startsWith('test-cap-'));
  assert(r.length >= 2, `expected ≥2 matches (alice/gpu + bob/api), got ${r.length}`);
  const tiers = r.map((x) => x.tier);
  const primaryIdx = tiers.indexOf('primary');
  const fallbackIdx = tiers.indexOf('fallback');
  if (primaryIdx !== -1 && fallbackIdx !== -1) {
    assert(primaryIdx < fallbackIdx, `primary tier should rank above fallback, got ${tiers.join(',')}`);
  }
  return { count: r.length, tiers };
});
stage('lookup-gpu', () => {
  const r = lookupCapabilities({ query: 'gpu' }).filter((c) => c.agent_id?.startsWith('test-cap-'));
  assert(r.length >= 2, `expected ≥2 gpu matches, got ${r.length}`);
  return { count: r.length };
});
stage('lookup-voice', () => {
  const r = lookupCapabilities({ query: 'voice' }).filter((c) => c.agent_id?.startsWith('test-cap-'));
  assert(r.length >= 1, `expected ≥1 voice match, got ${r.length}`);
  return { count: r.length };
});
stage('lookup-with-category-filter', () => {
  const r = lookupCapabilities({ query: 'gpu', category: 'hardware' })
    .filter((c) => c.agent_id?.startsWith('test-cap-'));
  assert(r.length >= 1, `expected ≥1 gpu+hardware match, got ${r.length}`);
  assert(r.every((x) => x.category === 'hardware'), 'category filter failed');
  return { count: r.length };
});
stage('lookup-minTier-primary', () => {
  const r = lookupCapabilities({ query: 'gpu', minTier: 'primary' })
    .filter((c) => c.agent_id?.startsWith('test-cap-'));
  assert(r.length >= 1, `expected ≥1 primary gpu match, got ${r.length}`);
  assert(r.every((x) => x.tier === 'primary'), `minTier filter failed, tiers: ${r.map((x) => x.tier)}`);
  return { count: r.length };
});

// 6. match (v1 stub) — realistic narrative workload must return results
stage('match-workload-narrative', () => {
  const r = matchCapabilities({ workload: 'I need to generate an image at high resolution' })
    .filter((c) => c.agent_id?.startsWith('test-cap-'));
  assert(r.length >= 1, `narrative workload should match, got ${r.length}`);
  return { count: r.length, top: r[0]?.name };
});
stage('match-workload-short', () => {
  const r = matchCapabilities({ workload: 'voice synthesis' })
    .filter((c) => c.agent_id?.startsWith('test-cap-'));
  assert(r.length >= 1, `short workload should match, got ${r.length}`);
  return { count: r.length, top: r[0]?.name };
});

// 7. verify not-found → returns, does not throw (idempotent/REST-style)
stage('verify-nonexistent-returns-not-throws', () => {
  const r = verifyCapability({ agentId: CAROL, name: 'does-not-exist' });
  assert(r.verified === false, `expected verified:false, got ${JSON.stringify(r)}`);
  assert(r.error === 'not_found', `expected error:not_found, got ${r.error}`);
  return r;
});

// 8. remove + verify count drops
stage('remove-bob-gpu-fallback', () => {
  const r = removeCapability({ agentId: BOB, name: 'gpu-fallback' });
  assert(r.removed === true, 'expected removed:true');
  return r;
});
stage('list-bob-after-remove', () => {
  const r = listCapabilities({ agent: BOB });
  assert(r.length === 1, `bob should have 1 cap after remove, got ${r.length}`);
  assert(r[0].name === 'api-imagegen', `expected api-imagegen, got ${r[0]?.name}`);
  return { count: r.length, remaining: r[0].name };
});

// cleanup
stage('cleanup', () => {
  const db = getDb();
  const c = db.prepare("DELETE FROM capabilities WHERE agent_id LIKE 'test-cap-%'").run();
  const a = db.prepare("DELETE FROM agents WHERE id LIKE 'test-cap-%'").run();
  return { capabilities_deleted: c.changes, agents_deleted: a.changes };
});

const failed = report.stages.filter((s) => !s.ok).length;
report.summary = {
  total: report.stages.length,
  passed: report.stages.length - failed,
  failed,
  verdict: failed === 0 ? 'GREEN' : 'RED',
};
console.log(JSON.stringify(report, null, 2));
process.exit(failed === 0 ? 0 : 1);
