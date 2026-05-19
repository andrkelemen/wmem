#!/usr/bin/env node
/**
 * benchmark-retrieval.mjs — wmem LongMemEval Retrieval Benchmark
 *
 * Modes:
 *   --mode keyword    FTS5 only (baseline)
 *   --mode expanded   FTS5 + synonym expansion
 *   --mode hybrid     FTS5 expanded + cross-encoder rerank (default)
 *   --mode full       hybrid + sub-query splitting for temporal
 *
 * Options:
 *   --top N           candidates before rerank (default 50)
 *   --rerank N        final results after rerank (default 5)
 *   --no-rerank       skip cross-encoder (for comparison runs)
 *   --output FILE     write hypothesis JSONL
 *
 * Usage:
 *   MEMORY_DB=./data/benchmark-bge.db node scripts/benchmark-retrieval.mjs data/longmemeval_s_cleaned.json --mode hybrid
 */

import { readFileSync, writeFileSync } from 'fs';
import { search, hybridSearch } from '../core/db.mjs';
import { expandQuery } from '../core/expander.mjs';
import { detectSubQueries } from '../core/subquery.mjs';
import { extractQueryFacets, summarizeFacets } from '../core/facets.mjs';

const args = process.argv.slice(2);
const dataPath = args.find(a => !a.startsWith('--'));
const mode = args.find(a => a.startsWith('--mode='))?.split('=')[1]
  || (args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'hybrid');
const topN = parseInt(args.find(a => a.startsWith('--top='))?.split('=')[1] || '200');
const rerankN = parseInt(args.find(a => a.startsWith('--rerank='))?.split('=')[1] || '5');
const noRerank = args.includes('--no-rerank');
const outputPath = args.find(a => a.startsWith('--output='))?.split('=')[1] || null;

if (!dataPath) {
  console.error(`usage: MEMORY_DB=./data/benchmark-bge.db node scripts/benchmark-retrieval.mjs <data.json> [--mode keyword|expanded|hybrid|full]`);
  process.exit(1);
}

// ── Cross-encoder reranker ───────────────────────────────────

let rerankerModel = null;
let rerankerTokenizer = null;

async function initReranker() {
  if (noRerank) return;
  try {
    const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@xenova/transformers');
    console.error('loading cross-encoder model (ms-marco-MiniLM-L-6-v2)...');
    rerankerTokenizer = await AutoTokenizer.from_pretrained('Xenova/ms-marco-MiniLM-L-6-v2');
    rerankerModel = await AutoModelForSequenceClassification.from_pretrained('Xenova/ms-marco-MiniLM-L-6-v2', { quantized: true });
    console.error('cross-encoder loaded.\n');
  } catch (err) {
    console.error(`cross-encoder failed to load: ${err.message}`);
    console.error('falling back to FTS5 ranking only.\n');
  }
}

async function rerankResults(query, candidates, limit = 5) {
  if (!rerankerModel || !rerankerTokenizer || candidates.length === 0) return candidates.slice(0, limit);

  // Score each candidate against the query using raw logits
  const scored = [];
  for (const c of candidates) {
    const text = (c.content || '').slice(0, 512); // truncate for model context
    try {
      const inputs = await rerankerTokenizer(query, { text_pair: text, padding: true, truncation: true });
      const output = await rerankerModel(inputs);
      const score = output.logits.data[0]; // raw logit — higher = more relevant
      scored.push({ ...c, rerankerScore: score });
    } catch {
      scored.push({ ...c, rerankerScore: -100 });
    }
  }

  return scored.sort((a, b) => b.rerankerScore - a.rerankerScore).slice(0, limit);
}

// ── Search pipeline ──────────────────────────────────────────

const stopWords = new Set(['what','when','where','who','how','did','does','do','is','are','was','were','the','a','an','my','your','our','i','me','we','you','they','he','she','it','and','or','but','in','on','at','to','for','of','with','from','by','about','that','this','which','have','has','had','can','could','would','should','will','may','might','been','being','than','then','also','just','only','very','much','many','some','any','other','each','all']);

function keywordSearch(question, limit) {
  const terms = question.replace(/[?!.,;:'"]/g, '').split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase())).slice(0, 6);
  return search(terms.join(' AND '), { limit });
}

function expandedSearch(question, limit) {
  const expanded = expandQuery(question);
  let results = search(expanded, { limit });
  // Boost user messages over assistant — answers more often in user turns
  return results.map(r => ({
    ...r,
    _boost: r.content?.startsWith('[user]') ? 2.0 : 1.0,
    _boostedRank: Math.abs(r.rank || 0) * (r.content?.startsWith('[user]') ? 2.0 : 1.0),
  })).sort((a, b) => b._boostedRank - a._boostedRank);
}

async function subQuerySearch(question, limit) {
  // Detect if question needs sub-query splitting (temporal/multi-event)
  let detected;
  try {
    detected = detectSubQueries(question);
  } catch {
    return expandedSearch(question, limit);
  }

  if (!detected || !detected.needsSplit || !detected.events?.length || detected.events.length <= 1) {
    return expandedSearch(question, limit);
  }

  // Search each event independently, merge results
  const allResults = new Map();
  for (const event of detected.events) {
    const results = expandedSearch(event, Math.ceil(limit / detected.events.length));
    for (const r of results) {
      if (!allResults.has(r.id)) {
        allResults.set(r.id, { ...r, subQueryHits: 1 });
      } else {
        allResults.get(r.id).subQueryHits++;
      }
    }
  }

  // Also search the full question to catch chunks that mention both events
  const fullResults = expandedSearch(question, Math.ceil(limit / 2));
  for (const r of fullResults) {
    if (!allResults.has(r.id)) {
      allResults.set(r.id, { ...r, subQueryHits: 0 });
    }
  }

  // Boost chunks that appear in multiple sub-queries
  return Array.from(allResults.values())
    .sort((a, b) => {
      if (a.subQueryHits !== b.subQueryHits) return b.subQueryHits - a.subQueryHits;
      return (b._boostedRank || 0) - (a._boostedRank || 0);
    });
}

// ── Main ─────────────────────────────────────────────────────

console.error(`wmem LongMemEval Benchmark — mode: ${mode}, rerank: ${noRerank ? 'OFF' : 'ON'}, top: ${topN}, final: ${rerankN}\n`);

const data = JSON.parse(readFileSync(dataPath, 'utf8'));
console.error(`loaded ${data.length} questions\n`);

// Initialize reranker for hybrid/full modes
if ((mode === 'hybrid' || mode === 'full') && !noRerank) {
  await initReranker();
}

let total = 0, recallAnyAt5 = 0, recallAt5 = 0;
const perType = {};
const hypotheses = [];
const timings = [];

for (const q of data) {
  total++;
  const type = q.question_type;
  if (!perType[type]) perType[type] = { total: 0, recallAny: 0, recallAll: 0 };
  perType[type].total++;

  const t0 = Date.now();
  let candidates = [];

  // Stage 1: Retrieve candidates
  if (mode === 'keyword') {
    candidates = keywordSearch(q.question, topN);
  } else if (mode === 'expanded') {
    candidates = expandedSearch(q.question, topN);
  } else if (mode === 'full') {
    candidates = await subQuerySearch(q.question, topN);
  } else if (mode === 'facets') {
    // PR-I: facet-routed retrieval — expanded keyword candidates + multi-axis
    // facet boost (topic+action tags, time window, project hint, role hint).
    // No embedding → exercises pure facet routing on top of FTS.
    candidates = hybridSearch(expandQuery(q.question), null, {
      limit: topN, facets: true,
    });
  } else {
    // hybrid (default)
    candidates = expandedSearch(q.question, topN);
  }

  // Stage 2: Rerank with cross-encoder (hybrid and full modes)
  let results;
  if ((mode === 'hybrid' || mode === 'full') && rerankerModel) {
    results = await rerankResults(q.question, candidates.slice(0, topN), rerankN);
  } else {
    results = candidates.slice(0, rerankN);
  }

  timings.push(Date.now() - t0);

  // Score: check if evidence sessions appear in top results
  const resultSessions = results.map(r => r.session_id).filter(Boolean);
  const foundAny = q.answer_session_ids.some(aid =>
    resultSessions.some(rs => rs === aid || rs.startsWith(aid))
  );
  const foundAll = q.answer_session_ids.every(aid =>
    resultSessions.some(rs => rs === aid || rs.startsWith(aid))
  );

  if (foundAny) { recallAnyAt5++; perType[type].recallAny++; }
  if (foundAll) { recallAt5++; perType[type].recallAll++; }

  const answer = results.map(r => r.content?.slice(0, 500)).join('\n---\n');
  hypotheses.push({ question_id: q.question_id, hypothesis: answer });

  if (total % 50 === 0) {
    const avgMs = Math.round(timings.slice(-50).reduce((a, b) => a + b, 0) / 50);
    console.error(`  ${total}/${data.length} | recall_any@5: ${(recallAnyAt5 / total * 100).toFixed(1)}% | avg: ${avgMs}ms/q`);
  }
}

const avgTime = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);

console.log(`\n=== wmem LongMemEval Results ===\n`);
console.log(`Mode:             ${mode}`);
console.log(`Reranker:         ${rerankerModel ? 'ON (ms-marco-MiniLM-L-6-v2)' : 'OFF'}`);
console.log(`Candidates:       ${topN}`);
console.log(`Final top-k:      ${rerankN}`);
console.log(`Total questions:  ${total}`);
console.log(`recall_any@5:     ${(recallAnyAt5 / total * 100).toFixed(2)}%  (${recallAnyAt5}/${total})`);
console.log(`recall@5:         ${(recallAt5 / total * 100).toFixed(2)}%  (${recallAt5}/${total})`);
console.log(`Avg query time:   ${avgTime}ms`);

console.log(`\n--- Per Type ---\n`);
console.log('| Type                           | Total | recall_any@5 | recall@5 |');
console.log('|--------------------------------|-------|-------------|----------|');
for (const [type, stats] of Object.entries(perType).sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`| ${type.padEnd(30)} | ${String(stats.total).padStart(5)} | ${(stats.recallAny / stats.total * 100).toFixed(1).padStart(10)}% | ${(stats.recallAll / stats.total * 100).toFixed(1).padStart(7)}% |`);
}

if (outputPath) {
  writeFileSync(outputPath, hypotheses.map(h => JSON.stringify(h)).join('\n'));
  console.error(`\nhypothesis file: ${outputPath}`);
}
