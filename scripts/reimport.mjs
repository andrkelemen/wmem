#!/usr/bin/env node
/**
 * reimport.mjs — CLI for backfill enrichment on existing indexed data
 *
 * Usage:
 *   MEMORY_DB=./data/memory.db node scripts/reimport.mjs [--agent myname] [--dry-run] [--verbose]
 *   MEMORY_DB=./data/memory.db node scripts/reimport.mjs --facts-only
 *   MEMORY_DB=./data/memory.db node scripts/reimport.mjs --bookmarks-only
 *   MEMORY_DB=./data/memory.db node scripts/reimport.mjs --kg-only
 */

import { runReimport } from '../core/reimport.mjs';

const args = process.argv.slice(2);
const agent = args.find(a => a.startsWith('--agent='))?.split('=')[1]
  || (args.includes('--agent') ? args[args.indexOf('--agent') + 1] : null);
const dryRun = args.includes('--dry-run');

const steps = args.includes('--facts-only') ? 'facts'
  : args.includes('--bookmarks-only') ? 'bookmarks'
  : args.includes('--kg-only') ? 'kg'
  : args.includes('--tags-only') ? 'tags'
  : args.includes('--preferences-only') ? 'preferences'
  : args.includes('--embeddings-only') ? 'embeddings'
  : args.includes('--with-embeddings') ? 'all+embeddings'
  : 'all';

console.error(`[reimport] starting${dryRun ? ' (DRY RUN)' : ''}${agent ? ` for agent: ${agent}` : ' for all agents'} — steps: ${steps}`);

const results = await runReimport({ agent, steps, dryRun });

console.log(JSON.stringify(results, null, 2));
