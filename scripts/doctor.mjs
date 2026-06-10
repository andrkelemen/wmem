#!/usr/bin/env node
/**
 * doctor.mjs — wmem health check, status, repair
 *
 * Usage:
 *   node scripts/doctor.mjs                — full health check
 *   node scripts/doctor.mjs --status       — quick status
 *   node scripts/doctor.mjs --fix          — auto-fix detected issues
 *   node scripts/doctor.mjs --dedup        — remove duplicate chunks
 *   node scripts/doctor.mjs --secrets [--agent X] [--limit N] [--json]  — scan chunks for known-shape secrets
 *   node scripts/doctor.mjs --purge <agent> [--force]  — delete all data for an agent
 *   node scripts/doctor.mjs --purge-personality <name> [--delete-data] [--force]
 *   node scripts/doctor.mjs --recover      — reset all sessions for re-indexing
 *   node scripts/doctor.mjs --checkpoint   — create a checkpoint
 *   node scripts/doctor.mjs --restore      — restore from last checkpoint
 */

import {
  runDoctor, getStatus, autoFix, dedup, validateIntegrity,
  purgeAgent, purgePersonality, checkSessionHealth,
  recoverAllSessions, createCheckpoint, restoreCheckpoint,
  atomicPersonalitySwitch,
} from '../core/doctor.mjs';
import { getDb } from '../core/db.mjs';
import { scanSecrets } from '../core/secret-patterns.mjs';

const args = process.argv.slice(2);
const command = args[0] || '';
const flags = new Set(args);
const getArg = (flag) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : null; };

if (command === '--status' || command === 'status') {
  const s = getStatus();
  console.log(`wmem status:`);
  console.log(`  chunks:      ${s.chunks}`);
  console.log(`  sessions:    ${s.sessions}`);
  console.log(`  tags:        ${s.tags}`);
  console.log(`  agents:      ${s.agents.length}`);
  console.log(`  personality: ${s.personality || 'none'}`);
  console.log(`  aliases:     ${s.aliases.length}`);
  console.log(`  DB size:     ${s.dbSizeMB}MB`);
  console.log(`  imports:     ${s.imports}`);
  console.log(`  stale:       ${s.staleImports}`);
  if (s.agents.length > 0) {
    console.log(`\n  agents:`);
    for (const a of s.agents) {
      console.log(`    ${a.agent.padEnd(20)} ${String(a.chunks).padStart(6)} chunks  ${String(a.sessions).padStart(4)} sessions`);
    }
  }

} else if (command === '--fix' || command === 'fix') {
  const result = autoFix();
  if (result.fixed) {
    console.log('fixes applied:');
    result.fixes.forEach(f => console.log(`  ✓ ${f}`));
  } else {
    console.log('no issues to fix.');
  }

} else if (command === '--dedup' || command === 'dedup') {
  const result = dedup();
  console.log(result.deduped > 0
    ? `removed ${result.deduped} duplicates across ${result.groups} groups`
    : 'no duplicates found');

} else if (command === '--secrets' || command === 'secrets') {
  // Cursor-style batch scan of chunks for known-shape secrets. Read-only:
  // surfaces hits per-pattern with chunk_id pointers, never mutates. Use
  // `memory_amend` or a future --redact-secrets pass to act on findings.
  const agentFilter = getArg('--agent');
  const limit = parseInt(getArg('--limit'), 10) || 0;
  const json = flags.has('--json');
  const samplePerPattern = parseInt(getArg('--sample'), 10) || 5;

  // Skip chunks above this byte length — secrets live in short messages /
  // config files, not in multi-MB pastes. Caps wall-clock without losing
  // useful coverage.
  const MAX_BYTES = 64 * 1024;
  const BATCH = 2000;

  const db = getDb();
  const byPattern = new Map();    // name → { count, samples: [{chunk_id, source, snippet}] }
  let scanned = 0, skippedOversize = 0, totalHits = 0;
  let cursor = 0;
  const t0 = Date.now();

  while (limit === 0 || scanned < limit) {
    const remaining = limit === 0 ? BATCH : Math.min(BATCH, limit - scanned);
    const params = agentFilter
      ? [agentFilter, cursor, remaining]
      : [cursor, remaining];
    const sql = agentFilter
      ? `SELECT id, agent, source_type, source_id, session_id, content,
                length(content) AS content_bytes
         FROM chunks WHERE agent = ? AND id > ?
         ORDER BY id ASC LIMIT ?`
      : `SELECT id, agent, source_type, source_id, session_id, content,
                length(content) AS content_bytes
         FROM chunks WHERE id > ?
         ORDER BY id ASC LIMIT ?`;
    const rows = db.prepare(sql).all(...params);
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = row.id;
      scanned += 1;
      if (row.content_bytes > MAX_BYTES) { skippedOversize += 1; continue; }
      const hits = scanSecrets(row.content);
      for (const hit of hits) {
        totalHits += 1;
        let bucket = byPattern.get(hit.name);
        if (!bucket) {
          bucket = { count: 0, samples: [] };
          byPattern.set(hit.name, bucket);
        }
        bucket.count += 1;
        if (bucket.samples.length < samplePerPattern) {
          const lo = Math.max(0, hit.offset - 15);
          const snippet = row.content.slice(lo, hit.offset)
            + `[${hit.preview}]`
            + row.content.slice(hit.offset + hit.length, hit.offset + hit.length + 15);
          bucket.samples.push({
            chunk_id: row.id,
            agent: row.agent,
            source_type: row.source_type,
            source_id: row.source_id,
            session_id: row.session_id,
            snippet: snippet.replace(/\s+/g, ' ').slice(0, 90),
          });
        }
      }
    }

    if (!json && scanned % 20000 < BATCH) {
      console.error(`[scan] ${scanned} chunks, ${totalHits} hits so far`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const result = {
    scanned, skipped_oversize: skippedOversize, hits: totalHits,
    elapsed_seconds: Number(elapsed),
    by_pattern: Object.fromEntries(
      [...byPattern.entries()].sort((a, b) => b[1].count - a[1].count)
    ),
    agent_filter: agentFilter || null,
    limit: limit || null,
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nsecret scan complete:`);
    console.log(`  scanned:           ${scanned} chunks`);
    console.log(`  skipped oversize:  ${skippedOversize}`);
    console.log(`  total hits:        ${totalHits}`);
    console.log(`  elapsed:           ${elapsed}s`);
    if (byPattern.size === 0) {
      console.log(`\n  no secrets detected.`);
    } else {
      console.log(`\nhits by pattern (most → fewest):`);
      for (const [name, bucket] of Object.entries(result.by_pattern)) {
        console.log(`  ${name.padEnd(24)} ${String(bucket.count).padStart(6)}`);
      }
      console.log(`\nsamples (up to ${samplePerPattern} per pattern):`);
      for (const [name, bucket] of Object.entries(result.by_pattern)) {
        console.log(`\n  ${name}:`);
        for (const s of bucket.samples) {
          console.log(`    chunk=${s.chunk_id} agent=${s.agent} source=${s.source_type}/${s.source_id || '-'}`);
          console.log(`      ${s.snippet}`);
        }
      }
      console.log(`\nto inspect a chunk:  SELECT content FROM chunks WHERE id = <id>;`);
      console.log(`to redact a chunk:   memory_amend  (preview shown above is already redacted)`);
    }
  }

} else if (command === '--purge') {
  const agent = getArg('--purge');
  if (!agent) { console.error('usage: --purge <agent> [--force]'); process.exit(1); }
  if (!flags.has('--force')) {
    const preview = purgeAgent(agent, { dryRun: true });
    console.log(`would delete from "${agent}": ${preview.chunks} chunks, ${preview.tags} tags`);
    console.log('run with --force to execute');
  } else {
    const result = purgeAgent(agent);
    console.log(`purged "${agent}": ${result.chunks} chunks, ${result.tags} tags, ${result.sessions} sessions`);
  }

} else if (command === '--purge-personality') {
  const name = getArg('--purge-personality');
  if (!name) { console.error('usage: --purge-personality <name> [--delete-data] [--force]'); process.exit(1); }
  const deleteData = flags.has('--delete-data');
  if (!flags.has('--force')) {
    const preview = purgePersonality(name, { deleteData, dryRun: true });
    console.log(`would delete personality "${name}"${deleteData ? ' + all data' : ''}: ${preview.chunks} chunks`);
    console.log('run with --force to execute');
  } else {
    const result = purgePersonality(name, { deleteData });
    console.log(`deleted personality "${name}"${deleteData ? ' + data' : ''}`);
    if (result.data) console.log(`  data: ${result.data.chunks} chunks, ${result.data.tags} tags`);
  }

} else if (command === '--recover' || command === 'recover') {
  const result = recoverAllSessions();
  console.log(`${result.recovered} sessions reset. run indexer with --force to re-index.`);

} else if (command === '--checkpoint') {
  const cp = createCheckpoint();
  console.log(`checkpoint created: personality=${cp.personality || 'none'}`);

} else if (command === '--restore') {
  const result = restoreCheckpoint();
  console.log(result.restored
    ? `restored: personality=${result.personality} from ${result.from}`
    : `restore failed: ${result.reason}`);

} else if (command === '--sessions') {
  const health = checkSessionHealth();
  console.log(`session health: ${health.healthy} healthy, ${health.stale} stale, ${health.orphaned} orphaned, ${health.corrupted} corrupted`);
  if (health.details.length > 0) {
    health.details.slice(0, 10).forEach(d => console.log(`  ${d.session?.slice(0, 12)}... ${d.issue}`));
  }

} else {
  // Full doctor check
  const result = runDoctor();
  console.log(result.summary);
  if (!result.healthy) {
    console.log('\nissues:');
    result.integrity.issues.forEach(i => {
      console.log(`  ⚠ ${i.type}: ${i.count || ''} ${i.reason || ''}`);
    });
    console.log('\nrun: node scripts/doctor.mjs --fix');
  }
  console.log(`\nstats: ${result.status.chunks} chunks, ${result.status.sessions} sessions, ${result.status.agents.length} agents, ${result.status.dbSizeMB}MB`);
}
