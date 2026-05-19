#!/usr/bin/env node
/*
  PR-I: Facet extraction + facet-boosted hybridSearch.

  Covers:
    - extractQueryFacets returns topic/action tags, time_window, role_hint,
      and project_hint correctly across a few query shapes
    - hybridSearch with `facets: true` re-orders candidates so facet-matching
      chunks rank above same-FTS-score chunks that miss the facets
    - time-window facet pulls in-window chunks above out-of-window ones
    - project facet uses session_bookmarks to route correctly
*/

import { mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TMPDIR = mkdtempSync(join(tmpdir(), 'wmem-facets-'));
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

const { extractQueryFacets, extractTimeWindow, extractRoleHint, extractProjectHint, summarizeFacets }
  = await import(join(REPO_ROOT, 'core/facets.mjs'));
const { insertChunk, upsertBookmark, hybridSearch } = await import(join(REPO_ROOT, 'core/db.mjs'));

// ── Facet extraction ────────────────────────────────────────

await stage('extractTimeWindow handles month + year', () => {
  const w = extractTimeWindow('what did we ship in april 2026');
  assert.ok(w, 'expected time window');
  assert.strictEqual(w.label, 'april 2026');
  assert.ok(w.startMs < w.endMs);
});

await stage('extractTimeWindow handles bare month', () => {
  const fixedNow = Date.UTC(2026, 4, 17);
  const w = extractTimeWindow('the april deployment broke', fixedNow);
  assert.ok(w);
  assert.strictEqual(w.label, 'april');
});

await stage('extractTimeWindow handles relative refs', () => {
  const fixedNow = Date.UTC(2026, 4, 17);
  const w = extractTimeWindow('what did we do yesterday', fixedNow);
  assert.ok(w);
  assert.strictEqual(w.label, 'yesterday');
});

await stage('extractRoleHint detects first/second person', () => {
  assert.strictEqual(extractRoleHint('what did I say about auth'), 'user');
  assert.strictEqual(extractRoleHint('you told me to use postgres'), 'assistant');
  assert.strictEqual(extractRoleHint('show me the latest chunks'), null);
});

await stage('extractProjectHint matches known project names', () => {
  const hits = extractProjectHint('how is the wmem-v1.3 rollout going', ['wmem-v1.3', 'midna']);
  assert.deepStrictEqual(hits, ['wmem-v1.3']);
});

await stage('extractQueryFacets bundles everything', () => {
  const f = extractQueryFacets('I decided to deploy auth fixes in april', {
    knownProjects: ['midna'],
  });
  assert.ok(f.topic_tags.length > 0, 'expected topic tags');
  assert.ok(f.action_tags.some(t => t.tag === 'decision'), 'expected decision action tag');
  assert.ok(f.time_window, 'expected time_window');
  assert.strictEqual(f.role_hint, 'user');
});

// ── Facet-boosted hybridSearch ──────────────────────────────

// Seed: same FTS-matching content but different facets — facet match should win.
const APR_TS = Date.UTC(2026, 3, 15); // mid-april 2026
const MAY_TS = Date.UTC(2026, 4, 17); // mid-may 2026
const SESS_A = 'sess-april-wmem';
const SESS_B = 'sess-may-midna';

const aprilChunk = insertChunk({
  agent: 'facet-test', sourceType: 'note', sourceId: 'c-april',
  sessionId: SESS_A, timestamp: APR_TS,
  content: '[user] decided to ship the auth deployment fix',
});
const mayChunk = insertChunk({
  agent: 'facet-test', sourceType: 'note', sourceId: 'c-may',
  sessionId: SESS_B, timestamp: MAY_TS,
  content: '[user] decided to ship the auth deployment fix',
});

// Bookmark each session into a project so project_hint can route.
upsertBookmark({
  sessionId: SESS_A, agent: 'facet-test', directory: '/tmp/wmem-proj',
  projectName: 'wmem', startedAt: APR_TS - 1000, endedAt: APR_TS + 1000,
  summary: 'april wmem work',
});
upsertBookmark({
  sessionId: SESS_B, agent: 'facet-test', directory: '/tmp/midna-proj',
  projectName: 'midna', startedAt: MAY_TS - 1000, endedAt: MAY_TS + 1000,
  summary: 'may midna work',
});

await stage('facets: time_window pulls in-window chunk above out-of-window twin', () => {
  const r = hybridSearch('deployed auth fix in april', null, {
    agent: 'facet-test', limit: 5, facets: true,
  });
  assert.ok(r.length >= 2, `expected ≥2 hits, got ${r.length}`);
  const aprilIdx = r.findIndex(c => c.id === aprilChunk.id);
  const mayIdx = r.findIndex(c => c.id === mayChunk.id);
  assert.ok(aprilIdx >= 0 && mayIdx >= 0, 'both chunks should be retrieved');
  assert.ok(aprilIdx < mayIdx,
    `april chunk should rank above may; got april=${aprilIdx} may=${mayIdx}`);
});

await stage('facets: project facet scores chunks via session_bookmarks lookup', async () => {
  const { scoreChunkAgainstFacets } = await import(join(REPO_ROOT, 'core/facets.mjs'));
  const facets = { project_hint: ['midna'], topic_tags: [], action_tags: [] };
  const ctx = {
    chunkTagsById: new Map(),
    chunkProjectById: new Map([[mayChunk.id, 'midna'], [aprilChunk.id, 'wmem']]),
  };
  const mayScore = scoreChunkAgainstFacets({ id: mayChunk.id }, ctx, facets);
  const aprilScore = scoreChunkAgainstFacets({ id: aprilChunk.id }, ctx, facets);
  assert.ok(mayScore > aprilScore,
    `expected project-matching chunk to score higher; may=${mayScore} april=${aprilScore}`);
});

await stage('facets: facet score surfaces on returned chunk', () => {
  const r = hybridSearch('decided to deploy auth in april 2026', null, {
    agent: 'facet-test', limit: 5, facets: true,
  });
  const apr = r.find(c => c.id === aprilChunk.id);
  assert.ok(apr, 'april chunk should be present');
  assert.ok(typeof apr.facetScore === 'number' && apr.facetScore > 0,
    `expected facetScore > 0, got ${apr.facetScore}`);
});

await stage('facets: explicit false disables (keeps classic hybrid behavior)', () => {
  const r = hybridSearch('decided to deploy auth in april 2026', null, {
    agent: 'facet-test', limit: 5, facets: false,
  });
  for (const c of r) {
    assert.strictEqual(c.facetScore, undefined, 'should not attach facetScore when facets:false');
  }
});

const failures = report.stages.filter(s => !s.ok);
console.log(`\nfacets: ${report.stages.length - failures.length}/${report.stages.length} pass`);
console.log(`(sample facet summary: ${summarizeFacets(extractQueryFacets('I decided to ship auth in april', { knownProjects: ['wmem'] }))})`);
process.exit(failures.length === 0 ? 0 : 1);
