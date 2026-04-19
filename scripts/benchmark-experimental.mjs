#!/usr/bin/env node
/**
 * benchmark-experimental.mjs — Query-routed retrieval benchmark
 *
 * The query classifier routes each question to a different candidate
 * pool composition. Same reranker, different inputs per question type.
 *
 * Question types:
 *   preference  → fact table lookup + FTS5 on fact-source sessions
 *   temporal    → sub-query splitting + date-anchored FTS5
 *   knowledge   → expanded FTS5 (widened pool)
 *   semantic    → expanded FTS5 (standard)
 *
 * A/B test against frozen benchmark-retrieval.mjs (49.0% baseline).
 *
 * Usage:
 *   MEMORY_DB=./data/benchmark-fresh.db node scripts/benchmark-experimental.mjs data/longmemeval_s_cleaned.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { search, searchFacts, getDb, hybridSearch, vectorSearch } from '../core/db.mjs';
import { expandQuery } from '../core/expander.mjs';
import { detectSubQueries } from '../core/subquery.mjs';

const args = process.argv.slice(2);
const dataPath = args.find(a => !a.startsWith('--'));
const topN = parseInt(args.find(a => a.startsWith('--top='))?.split('=')[1] || '200');
const rerankN = parseInt(args.find(a => a.startsWith('--rerank='))?.split('=')[1] || '5');
const noRerank = args.includes('--no-rerank');
const outputPath = args.find(a => a.startsWith('--output='))?.split('=')[1] || null;

if (!dataPath) {
  console.error('usage: MEMORY_DB=./data/benchmark-fresh.db node scripts/benchmark-experimental.mjs <data.json>');
  process.exit(1);
}

// ── Cross-encoder reranker ───────────────────────────────────

let rerankerModel = null;
let rerankerTokenizer = null;

async function initReranker() {
  if (noRerank) return;
  try {
    const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@xenova/transformers');
    console.error('loading cross-encoder model...');
    rerankerTokenizer = await AutoTokenizer.from_pretrained('Xenova/ms-marco-MiniLM-L-6-v2');
    rerankerModel = await AutoModelForSequenceClassification.from_pretrained('Xenova/ms-marco-MiniLM-L-6-v2', { quantized: true });
    console.error('cross-encoder loaded.\n');
  } catch (err) {
    console.error(`cross-encoder failed: ${err.message}\n`);
  }
}

async function rerankResults(query, candidates, limit = 5) {
  if (!rerankerModel || !rerankerTokenizer || candidates.length === 0) return candidates.slice(0, limit);

  const scored = [];
  for (const c of candidates) {
    const text = (c.content || '').slice(0, 512);
    try {
      const inputs = await rerankerTokenizer(query, { text_pair: text, padding: true, truncation: true });
      const output = await rerankerModel(inputs);
      scored.push({ ...c, rerankerScore: output.logits.data[0] });
    } catch {
      scored.push({ ...c, rerankerScore: -100 });
    }
  }

  return scored.sort((a, b) => b.rerankerScore - a.rerankerScore).slice(0, limit);
}

// ── Query embedding ──────────────────────────────────────────

let embedPipeline = null;
const useHybrid = !args.includes('--no-hybrid');

async function initEmbedder() {
  if (!useHybrid) return;
  try {
    const { pipeline } = await import('@xenova/transformers');
    // Detect model from DB vector dimensions
    const db = getDb();
    let dims = 384;
    try {
      const row = db.prepare('SELECT embedding FROM chunks_vec LIMIT 1').get();
      if (row?.embedding) dims = row.embedding.length / 4;
    } catch {}

    const model = dims === 1024 ? 'Xenova/bge-large-en-v1.5' : 'Xenova/all-MiniLM-L6-v2';
    console.error(`loading embedding model (${model}, ${dims}d)...`);
    embedPipeline = await pipeline('feature-extraction', model);
    console.error('embedder loaded.\n');
  } catch (err) {
    console.error(`embedder failed: ${err.message}\n`);
  }
}

async function embedQuery(text) {
  if (!embedPipeline) return null;
  const truncated = text.length > 512 ? text.slice(0, 512) : text;
  const result = await embedPipeline(truncated, { pooling: 'mean', normalize: true });
  return new Float32Array(result.data);
}

// ── Search functions ─────────────────────────────────────────

const stopWords = new Set(['what','when','where','who','how','did','does','do','is','are','was','were','the','a','an','my','your','our','i','me','we','you','they','he','she','it','and','or','but','in','on','at','to','for','of','with','from','by','about','that','this','which','have','has','had','can','could','would','should','will','may','might','been','being','than','then','also','just','only','very','much','many','some','any','other','each','all']);

function expandedSearch(question, limit) {
  const expanded = expandQuery(question);
  let results = search(expanded, { limit });
  return results.map(r => ({
    ...r,
    _boost: r.content?.startsWith('[user]') ? 2.0 : 1.0,
    _boostedRank: Math.abs(r.rank || 0) * (r.content?.startsWith('[user]') ? 2.0 : 1.0),
  })).sort((a, b) => b._boostedRank - a._boostedRank);
}

// ── Query classifier ─────────────────────────────────────────

function classifyQuestion(question) {
  const q = question.toLowerCase();

  // Preference: "can you recommend/suggest" patterns — these require knowing user context
  if (/\b(?:can you|could you)\s+(?:recommend|suggest)\b/.test(q)) return 'preference';
  if (/\bany\s+(?:tips|suggestions|advice|ideas)\b/.test(q)) return 'preference';
  if (/\bwhat\s+should\s+i\s+(?:serve|make|cook|buy|get|try|watch|read)\b/.test(q)) return 'preference';
  if (/\bmy\s+favorite\b/.test(q)) return 'preference';
  if (/\bdo\s+i\s+prefer\b/.test(q)) return 'preference';
  if (/\bam\s+i\s+allergic\b/.test(q)) return 'preference';
  if (/\bwhat\s+(?:kind|type)\s+of\s+\w+\s+do\s+i\s+(?:like|prefer|enjoy)\b/.test(q)) return 'preference';

  // Temporal: duration, ordering, date-anchored, time-expression recall
  if (/\bhow\s+(?:many|long)\s+(?:days?|weeks?|months?)\b/.test(q)) return 'temporal';
  if (/\bwhich\s+(?:happened|came|was)\s+first\b/.test(q)) return 'temporal';
  if (/\bwhat\s+(?:is\s+the\s+)?order\b/.test(q)) return 'temporal';
  if (/\bbetween\s+.+\s+and\s+/.test(q)) return 'temporal';
  if (/\b(?:before|after)\s+(?:i|my|the)\b/.test(q)) return 'temporal';
  // Time-anchored recall: "what did I do last Tuesday", "who did I meet 3 weeks ago"
  if (/\b(?:last|previous|past)\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(q)) return 'temporal';
  if (/\b\d+\s+(?:days?|weeks?|months?)\s+ago\b/.test(q)) return 'temporal';
  if (/\ba\s+(?:week|month|couple\s+of\s+days?|few\s+days?)\s+ago\b/.test(q)) return 'temporal';
  if (/\b(?:in|on|during)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(q)) return 'temporal';
  if (/\b(?:on|last)\s+(?:valentine|christmas|thanksgiving|easter|halloween)\b/.test(q)) return 'temporal';
  if (/\bi\s+mentioned\b.*\bago\b/.test(q)) return 'temporal';
  if (/\bfirst\s+(?:time|issue|day)\b/.test(q)) return 'temporal';
  if (/\bwhich\s+\w+\s+did\s+i\s+\w+\s+first\b/.test(q)) return 'temporal';
  if (/\bin\s+total\b.*\bspent?\b/.test(q)) return 'temporal';

  // Knowledge update: "did I change", "what did I update", "new information"
  if (/\bdid\s+(?:i|my)\s+(?:change|update|modify|switch|replace)\b/.test(q)) return 'knowledge';
  if (/\bwhat\s+(?:change|update|new)\b/.test(q)) return 'knowledge';

  return 'semantic';
}

// ── Route-specific candidate builders ────────────────────────

/**
 * Preference route: pure hybrid search.
 *
 * Previous version lookup'd searchFacts first and used fact-source sessions
 * as the candidate seed. Fact extraction is too dirty (stopwords dominating
 * subjects, run-on phrase capture) — it pulls chunks from wrong sessions and
 * poisons the pool. Vectors alone find preference answers via semantic match
 * (e.g. "suggest a hotel for Miami" → session discussing rooftop pools in
 * Seattle) which is the exact shape of these questions.
 */
async function preferencePool(question, limit) {
  if (embedPipeline) {
    const queryVec = await embedQuery(question);
    if (queryVec) {
      return hybridSearch(expandQuery(question), queryVec, { limit });
    }
  }
  return expandedSearch(question, limit);
}

/**
 * Temporal route: sub-query splitting + widened FTS5
 */
async function temporalPool(question, limit) {
  let detected;
  try {
    detected = detectSubQueries(question);
  } catch {
    return expandedSearch(question, limit);
  }

  if (!detected || !detected.needsSplit || !detected.events?.length || detected.events.length <= 1) {
    return expandedSearch(question, limit);
  }

  const allResults = new Map();

  // Search each event independently
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

  // Also search full question
  const fullResults = expandedSearch(question, Math.ceil(limit / 2));
  for (const r of fullResults) {
    if (!allResults.has(r.id)) {
      allResults.set(r.id, { ...r, subQueryHits: 0 });
    }
  }

  return Array.from(allResults.values())
    .sort((a, b) => {
      if (a.subQueryHits !== b.subQueryHits) return b.subQueryHits - a.subQueryHits;
      return (b._boostedRank || 0) - (a._boostedRank || 0);
    })
    .slice(0, limit);
}

/**
 * Knowledge route: widened FTS5 pool (knowledge-update questions need broader recall)
 */
function knowledgePool(question, limit) {
  return expandedSearch(question, limit);
}

/**
 * Semantic route: hybrid FTS5 + vector search when embeddings available
 */
async function semanticPool(question, limit) {
  if (embedPipeline) {
    const queryVec = await embedQuery(question);
    if (queryVec) {
      return hybridSearch(expandQuery(question), queryVec, { limit });
    }
  }
  return expandedSearch(question, limit);
}

// ── Main ─────────────────────────────────────────────────────

console.error(`wmem Experimental Benchmark — query-routed retrieval`);
console.error(`  candidates: ${topN}, final: ${rerankN}, rerank: ${noRerank ? 'OFF' : 'ON'}\n`);

const data = JSON.parse(readFileSync(dataPath, 'utf8'));
console.error(`loaded ${data.length} questions\n`);

await initReranker();
await initEmbedder();

let total = 0, recallAnyAt5 = 0, recallAt5 = 0;
const perType = {};
const perRoute = { preference: 0, temporal: 0, knowledge: 0, semantic: 0 };
const hypotheses = [];
const timings = [];

for (const q of data) {
  total++;
  const type = q.question_type;
  if (!perType[type]) perType[type] = { total: 0, recallAny: 0, recallAll: 0 };
  perType[type].total++;

  const t0 = Date.now();

  // Classify and route
  const route = classifyQuestion(q.question);
  perRoute[route]++;

  let candidates;
  switch (route) {
    case 'preference':
      candidates = await preferencePool(q.question, topN);
      break;
    case 'temporal':
      candidates = await temporalPool(q.question, topN);
      break;
    case 'knowledge':
      candidates = await semanticPool(q.question, topN);
      break;
    default:
      candidates = await semanticPool(q.question, topN);
  }

  // Rerank over the full candidate pool returned by the route.
  // Then dedupe by session_id — recall is measured at session level, and 5
  // chunks from 1 session covers fewer sessions than 5 chunks from 5 sessions.
  const dedupeSessions = !args.includes('--no-session-dedupe');
  let results;
  if (rerankerModel) {
    // Rerank more candidates when we'll dedupe — otherwise dedupe may
    // starve the top-5 if the pool is cluster-heavy.
    const rerankSize = dedupeSessions ? Math.min(50, candidates.length) : rerankN;
    const reranked = await rerankResults(q.question, candidates, rerankSize);
    if (dedupeSessions) {
      const seen = new Set();
      results = [];
      for (const r of reranked) {
        const key = r.session_id || `__no_session_${r.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(r);
          if (results.length >= rerankN) break;
        }
      }
    } else {
      results = reranked.slice(0, rerankN);
    }
  } else {
    results = candidates.slice(0, rerankN);
  }

  timings.push(Date.now() - t0);

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

console.log(`\n=== wmem Experimental Results (Query-Routed) ===\n`);
console.log(`Candidates:       ${topN}`);
console.log(`Final top-k:      ${rerankN}`);
console.log(`Reranker:         ${rerankerModel ? 'ON' : 'OFF'}`);
console.log(`Total questions:  ${total}`);
console.log(`recall_any@5:     ${(recallAnyAt5 / total * 100).toFixed(2)}%  (${recallAnyAt5}/${total})`);
console.log(`recall@5:         ${(recallAt5 / total * 100).toFixed(2)}%  (${recallAt5}/${total})`);
console.log(`Avg query time:   ${avgTime}ms`);

console.log(`\nRoute distribution:`);
for (const [route, count] of Object.entries(perRoute)) {
  console.log(`  ${route}: ${count} (${(count / total * 100).toFixed(1)}%)`);
}

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
