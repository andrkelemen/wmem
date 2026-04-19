#!/usr/bin/env node
/**
 * doctor.mjs — wmem health check, status, repair
 *
 * Usage:
 *   node scripts/doctor.mjs                — full health check
 *   node scripts/doctor.mjs --status       — quick status
 *   node scripts/doctor.mjs --fix          — auto-fix detected issues
 *   node scripts/doctor.mjs --dedup        — remove duplicate chunks
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
