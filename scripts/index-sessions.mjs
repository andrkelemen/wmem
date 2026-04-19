#!/usr/bin/env node
/**
 * index-sessions.mjs — CLI for incremental session indexing
 *
 * Usage:
 *   node scripts/index-sessions.mjs [--dir ~/.claude/projects] [--agent default] [--verbose]
 *   node scripts/index-sessions.mjs --auto-agent --verbose
 *   node scripts/index-sessions.mjs --auto-agent --merge morning=myagent --merge clean=myagent
 *   node scripts/index-sessions.mjs --list-aliases
 *   node scripts/index-sessions.mjs --remove-alias morning
 *
 * Flags:
 *   --auto-agent     Auto-detect agent from JSONL content / CLAUDE.md / path
 *   --merge X=Y      Create alias: detected name X maps to canonical agent Y
 *   --list-aliases   Show all aliases
 *   --remove-alias X Remove an alias
 *   --embed          Generate vector embeddings (slower first run)
 *   --force          Re-index from byte 0 (after extractor upgrades)
 *   --verbose        Show per-file progress
 */

import { indexSessions } from '../core/indexer.mjs';
import { createAlias, removeAlias, listAliases, getAgentSummary } from '../core/db.mjs';
import { homedir } from 'os';
import { join } from 'path';

const args = parseArgs(process.argv.slice(2));

// ── Alias management commands (no indexing) ─────────────

if (args['list-aliases']) {
  const aliases = listAliases();
  if (aliases.length === 0) {
    console.log('No aliases configured.');
  } else {
    console.log('Agent aliases:');
    for (const a of aliases) {
      console.log(`  ${a.alias} → ${a.canonical}`);
    }
  }
  process.exit(0);
}

if (args['remove-alias']) {
  const result = removeAlias(args['remove-alias']);
  console.log(result.removed ? `Removed alias "${args['remove-alias']}"` : `Alias "${args['remove-alias']}" not found`);
  process.exit(0);
}

// ── Process --merge flags ───────────────────────────────

if (args.merge && args.merge.length > 0) {
  for (const m of args.merge) {
    const [alias, canonical] = m.split('=');
    if (!alias || !canonical) {
      console.error(`Invalid merge: "${m}" — use --merge alias=canonical`);
      continue;
    }
    const result = createAlias(alias, canonical);
    if (result.created) {
      console.error(`alias: ${alias} → ${canonical} (retagged: ${result.retagged.chunks} chunks, ${result.retagged.sessions} sessions)`);
    } else {
      console.error(`alias failed: ${result.reason}`);
    }
  }
}

// ── Indexing ────────────────────────────────────────────

const dir = args.dir || join(homedir(), '.claude', 'projects');
const agent = args['auto-agent'] ? 'auto' : (args.agent || process.env.WMEM_AGENT || 'default');
const verbose = args.verbose || false;
const force = args.force || false;
const maxFileMB = args['max-file-mb'] ? parseInt(args['max-file-mb']) : 0;

// Auto-embed: on if DB already has vectors (user has semantic search wired),
// off by default otherwise. --embed forces on, --no-embed forces off.
let useEmbed;
if (args['no-embed']) {
  useEmbed = false;
} else if (args.embed) {
  useEmbed = true;
} else {
  try {
    const { getDb } = await import('../core/db.mjs');
    const row = getDb().prepare('SELECT rowid FROM chunks_vec LIMIT 1').get();
    useEmbed = !!row;
    if (useEmbed) console.error('wmem index — DB has vectors, auto-enabling embedding');
  } catch {
    useEmbed = false;
  }
}

let embedFn = null;
if (useEmbed) {
  console.error('wmem index — loading embedding model...');
  const { embed } = await import('../core/embeddings.mjs');
  embedFn = embed;
  console.error('wmem index — embedding model ready');
}

console.error(`wmem index — scanning ${dir} for agent "${agent}"${force ? ' (FORCE)' : ''}`);

const result = await indexSessions({ dir, agent, maxFileMB, verbose, embedFn, force });

console.error(`done: ${result.indexed} files indexed, ${result.newChunks} new chunks, ${result.newSessions} new sessions, ${result.skipped} skipped, ${result.errors} errors`);

// ── Show agent summary after auto-agent indexing ────────

if (args['auto-agent'] || args['show-agents']) {
  const summary = getAgentSummary();
  const aliases = listAliases();
  const aliasMap = new Map(aliases.map(a => [a.canonical, a]));

  console.error('\nagent summary:');
  for (const a of summary) {
    const hasAlias = aliases.some(al => al.canonical === a.agent);
    const isDefault = a.agent === 'default';
    const marker = isDefault ? '  (default)' : hasAlias ? '  (has aliases)' : '';
    console.error(`  ${a.agent.padEnd(20)} ${String(a.sessions).padStart(4)} sessions  ${String(a.chunks).padStart(6)} chunks${marker}`);
  }

  if (aliases.length > 0) {
    console.error('\nactive aliases:');
    for (const a of aliases) {
      console.error(`  ${a.alias} → ${a.canonical}`);
    }
  }
}

if (result.errors > 0) process.exit(1);

// ── Arg parser ──────────────────────────────────────────

function parseArgs(argv) {
  const result = { merge: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) result.dir = argv[++i];
    else if (argv[i] === '--agent' && argv[i + 1]) result.agent = argv[++i];
    else if (argv[i] === '--max-file-mb' && argv[i + 1]) result['max-file-mb'] = argv[++i];
    else if (argv[i] === '--verbose' || argv[i] === '-v') result.verbose = true;
    else if (argv[i] === '--embed') result.embed = true;
    else if (argv[i] === '--force') result.force = true;
    else if (argv[i] === '--auto-agent') result['auto-agent'] = true;
    else if (argv[i] === '--show-agents') result['show-agents'] = true;
    else if (argv[i] === '--merge' && argv[i + 1]) result.merge.push(argv[++i]);
    else if (argv[i] === '--list-aliases') result['list-aliases'] = true;
    else if (argv[i] === '--remove-alias' && argv[i + 1]) result['remove-alias'] = argv[++i];
  }
  return result;
}
