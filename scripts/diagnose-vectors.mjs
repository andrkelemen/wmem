#!/usr/bin/env node
/**
 * diagnose-vectors.mjs — inspect what bge-large pulls wrongfully
 *
 * For each sampled question:
 *   - fetch FTS5 top-20 (frozen path)
 *   - fetch vector top-20
 *   - fetch hybrid top-20
 *   - report: is the correct answer session in each pool? at what rank?
 *             what wrong sessions rank high in vector that FTS5 ignores?
 *
 * Usage:
 *   MEMORY_DB=./data/benchmark-bge.db node scripts/diagnose-vectors.mjs \
 *     ~/source/LongMemEval/data/longmemeval_s_cleaned.json \
 *     --type=knowledge-update --n=10
 */

import { readFileSync } from 'fs';
import { search, vectorSearch, hybridSearch, getDb } from '../core/db.mjs';
import { expandQuery } from '../core/expander.mjs';

const args = process.argv.slice(2);
const dataPath = args.find(a => !a.startsWith('--'));
const filterType = args.find(a => a.startsWith('--type='))?.split('=')[1] || null;
const n = parseInt(args.find(a => a.startsWith('--n='))?.split('=')[1] || '10');
const poolSize = parseInt(args.find(a => a.startsWith('--pool='))?.split('=')[1] || '20');

if (!dataPath) {
  console.error('usage: MEMORY_DB=<db> node scripts/diagnose-vectors.mjs <data.json> [--type=<t>] [--n=<N>] [--pool=<P>]');
  process.exit(1);
}

const { pipeline } = await import('@xenova/transformers');

const db = getDb();
let dims = 384;
try {
  const row = db.prepare('SELECT embedding FROM chunks_vec LIMIT 1').get();
  if (row?.embedding) dims = row.embedding.length / 4;
} catch {}

const modelName = dims === 1024 ? 'Xenova/bge-large-en-v1.5' : 'Xenova/all-MiniLM-L6-v2';
console.error(`loading ${modelName} (${dims}d)...`);
const embed = await pipeline('feature-extraction', modelName);
console.error('loaded.\n');

async function embedQuery(text) {
  const t = text.length > 512 ? text.slice(0, 512) : text;
  const r = await embed(t, { pooling: 'mean', normalize: true });
  return new Float32Array(r.data);
}

const data = JSON.parse(readFileSync(dataPath, 'utf8'));
const filtered = filterType ? data.filter(q => q.question_type === filterType) : data;
const sample = filtered.slice(0, n);

console.log(`\n=== diagnose-vectors: ${sample.length} questions, type=${filterType || 'all'} ===\n`);

let ftsHits = 0, vecHits = 0, hybridHits = 0;
const wrongSessionCounter = new Map(); // session_id → count of times it polluted a pool

for (const q of sample) {
  console.log(`\n--- Q: ${q.question_id} [${q.question_type}]`);
  console.log(`    question: ${q.question}`);
  console.log(`    correct sessions: ${q.answer_session_ids.join(', ')}`);

  const expanded = expandQuery(q.question);
  const qVec = await embedQuery(q.question);

  const ftsResults = search(expanded, { limit: poolSize });
  const vecResults = vectorSearch(qVec, { limit: poolSize });
  const hybridResults = hybridSearch(expanded, qVec, { limit: poolSize });

  const matchesAny = (sessions, correct) => sessions.some(s => correct.some(c => s === c || s?.startsWith(c)));

  const ftsSessions = ftsResults.map(r => r.session_id).filter(Boolean);
  const vecSessions = vecResults.map(r => r.session_id).filter(Boolean);
  const hybridSessions = hybridResults.map(r => r.session_id).filter(Boolean);

  const ftsFound = matchesAny(ftsSessions, q.answer_session_ids);
  const vecFound = matchesAny(vecSessions, q.answer_session_ids);
  const hybridFound = matchesAny(hybridSessions, q.answer_session_ids);

  if (ftsFound) ftsHits++;
  if (vecFound) vecHits++;
  if (hybridFound) hybridHits++;

  // Rank of correct session in each pool
  const rankOf = (sessions, correct) => {
    for (let i = 0; i < sessions.length; i++) {
      if (correct.some(c => sessions[i] === c || sessions[i]?.startsWith(c))) return i + 1;
    }
    return null;
  };

  console.log(`    FTS5@${poolSize}:    ${ftsFound ? 'HIT' : 'miss'} (rank ${rankOf(ftsSessions, q.answer_session_ids) || '—'})`);
  console.log(`    VEC@${poolSize}:     ${vecFound ? 'HIT' : 'miss'} (rank ${rankOf(vecSessions, q.answer_session_ids) || '—'})`);
  console.log(`    HYBRID@${poolSize}:  ${hybridFound ? 'HIT' : 'miss'} (rank ${rankOf(hybridSessions, q.answer_session_ids) || '—'})`);

  // Failure mode diagnosis: vectors HURT when FTS5 found but hybrid didn't
  if (ftsFound && !hybridFound) {
    console.log(`    ⚠️  REGRESSION — FTS5 found it, hybrid lost it`);
    console.log(`    vector top-5 (polluting the pool):`);
    for (let i = 0; i < Math.min(5, vecResults.length); i++) {
      const r = vecResults[i];
      const wrong = !q.answer_session_ids.some(c => r.session_id === c || r.session_id?.startsWith(c));
      if (wrong && r.session_id) {
        wrongSessionCounter.set(r.session_id, (wrongSessionCounter.get(r.session_id) || 0) + 1);
      }
      const snippet = (r.content || '').slice(0, 120).replace(/\s+/g, ' ');
      console.log(`      ${i+1}. [${wrong ? 'WRONG' : 'ok   '}] dist=${(r.distance || 0).toFixed(3)} sess=${r.session_id?.slice(0,12) || '—'} | ${snippet}`);
    }
  }

  // Show vectors pulling non-overlapping sessions
  const ftsSet = new Set(ftsSessions);
  const vecOnlySessions = vecSessions.filter(s => !ftsSet.has(s));
  if (vecOnlySessions.length > 0 && (ftsFound || vecFound)) {
    console.log(`    vec-only sessions (not in FTS5 pool): ${vecOnlySessions.length}/${vecSessions.length}`);
  }
}

console.log(`\n=== totals ===`);
console.log(`FTS5:    ${ftsHits}/${sample.length}  (${(ftsHits/sample.length*100).toFixed(1)}%)`);
console.log(`VEC:     ${vecHits}/${sample.length}  (${(vecHits/sample.length*100).toFixed(1)}%)`);
console.log(`HYBRID:  ${hybridHits}/${sample.length}  (${(hybridHits/sample.length*100).toFixed(1)}%)`);

if (wrongSessionCounter.size > 0) {
  console.log(`\n=== top wrong sessions pulled by vectors on regressions ===`);
  const sorted = [...wrongSessionCounter.entries()].sort((a,b) => b[1] - a[1]).slice(0, 10);
  for (const [sess, count] of sorted) {
    console.log(`  ${count}x  ${sess}`);
  }
}
