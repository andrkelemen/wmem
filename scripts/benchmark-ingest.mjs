#!/usr/bin/env node
/**
 * benchmark-ingest.mjs — Ingest LongMemEval conversations into wmem
 *
 * Loads the benchmark dataset and indexes all conversation histories
 * into a fresh wmem database, one session per haystack session.
 *
 * Usage:
 *   MEMORY_DB=./data/benchmark.db node scripts/benchmark-ingest.mjs /path/to/longmemeval_s_cleaned.json
 */

import { readFileSync } from 'fs';
import { insertChunk, getDb, getStats } from '../core/db.mjs';
import { generateTags } from '../core/autotag.mjs';
import { insertTags } from '../core/db.mjs';

const dataPath = process.argv[2];
if (!dataPath) {
  console.error('usage: MEMORY_DB=./data/benchmark.db node scripts/benchmark-ingest.mjs <longmemeval_s_cleaned.json>');
  process.exit(1);
}

console.error('loading benchmark data...');
const data = JSON.parse(readFileSync(dataPath, 'utf8'));
console.error(`loaded ${data.length} questions`);

const db = getDb();
let totalChunks = 0;
let totalSessions = 0;
const seen = new Set(); // track unique sessions across questions

for (let qi = 0; qi < data.length; qi++) {
  const q = data[qi];
  const dates = q.haystack_dates || [];
  const sessionIds = q.haystack_session_ids || [];

  for (let si = 0; si < q.haystack_sessions.length; si++) {
    const session = q.haystack_sessions[si];
    const sessionId = sessionIds[si] || `q${qi}_s${si}`;
    const date = dates[si] || '2024-01-01';

    // Skip if we've already indexed this session (shared across questions)
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);

    const timestamp = new Date(date).getTime() || Date.now();

    for (const turn of session) {
      const content = `[${turn.role}] ${turn.content}`;
      const r = insertChunk({
        agent: 'benchmark',
        sourceType: 'conversation',
        sourceId: `longmemeval:${q.question_id}`,
        sessionId,
        content,
        timestamp,
        metadata: JSON.stringify({
          question_id: q.question_id,
          has_answer: turn.has_answer || false,
          session_id: sessionId,
          date,
        }),
      });

      if (!r.deduped) {
        totalChunks++;
        const tags = generateTags(content);
        if (tags.length > 0) insertTags(r.id, tags);
      }
    }

    totalSessions++;
  }

  if ((qi + 1) % 50 === 0) {
    console.error(`  ${qi + 1}/${data.length} questions processed, ${totalChunks} chunks, ${totalSessions} sessions`);
  }
}

const stats = getStats();
console.error(`\ndone: ${totalChunks} chunks indexed across ${totalSessions} unique sessions`);
console.error(`DB stats: ${JSON.stringify(stats)}`);
