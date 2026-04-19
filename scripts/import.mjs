#!/usr/bin/env node
/**
 * import.mjs — Manual document ingestion with tier placement
 *
 * Import external files (markdown, text, identity docs, notes) into wmem
 * with explicit tier control and proper metadata.
 *
 * Usage:
 *   node scripts/import.mjs --file us.md --agent myagent --tier L3
 *   node scripts/import.mjs --dir ./notes/ --agent myagent --auto-tier
 *   node scripts/import.mjs --file CLAUDE.md --agent myagent --always-load
 *   node scripts/import.mjs --file notes.md --agent myagent --dry-run
 */

import { importMarkdown, importFile, importDirectory, getImportStatus } from '../core/importer.mjs';
import { homedir } from 'os';

const args = parseArgs(process.argv.slice(2));

if (!args.file && !args.dir && !args.status) {
  console.log(`wmem import — ingest external files into memory

Usage:
  node scripts/import.mjs --file <path> --agent <name> [--tier L1|L2|L3] [--dry-run]
  node scripts/import.mjs --dir <path> --agent <name> [--auto-tier] [--dry-run]
  node scripts/import.mjs --status --agent <name>

Options:
  --file <path>     Import a single file
  --dir <path>      Import all .md/.txt files in a directory
  --agent <name>    Agent/personality name (required)
  --tier L1|L2|L3   Force tier placement (default: auto from content type)
  --auto-tier       Auto-classify tier based on content
  --always-load     Mark imported chunks for L1 injection every session
  --dry-run         Preview import without writing
  --status          Show import status for agent
  `);
  process.exit(0);
}

const agent = args.agent || process.env.WMEM_AGENT || 'default';

// ── Status ──────────────────────────────────────────────

if (args.status) {
  const status = getImportStatus(agent);
  if (status.length === 0) {
    console.log(`No imports for agent "${agent}".`);
  } else {
    console.log(`Imports for "${agent}":`);
    for (const s of status) {
      console.log(`  ${s.file.split('/').pop().split('\\').pop()} — ${s.chunks} chunks, ${s.freshness}`);
    }
  }
  process.exit(0);
}

// ── Import ──────────────────────────────────────────────

const dryRun = args['dry-run'] || false;
const tier = args.tier || null;
const alwaysLoad = args['always-load'] || false;

if (args.file) {
  console.log(`importing: ${args.file} → agent="${agent}"${tier ? ` tier=${tier}` : ''}${dryRun ? ' (DRY RUN)' : ''}`);

  const result = importMarkdown(args.file, agent, { dryRun });

  if (dryRun) {
    console.log(`\nsections: ${result.sections}, flagged: ${result.flagged.length}`);
    result.classified.forEach(c => {
      const flag = c.confidence < 0.5 ? '⚠' : '✓';
      const tierLabel = tier || (c.type === 'personality' ? 'L3' : c.type === 'config' ? 'L3' : 'L2');
      console.log(`  ${flag} [${tierLabel}] ${c.section?.slice(0, 50)}`);
    });
  } else {
    console.log(`✓ ${result.sections} sections → ${result.chunks} chunks (${result.flagged.length} flagged)`);
  }

} else if (args.dir) {
  console.log(`importing directory: ${args.dir} → agent="${agent}"${dryRun ? ' (DRY RUN)' : ''}`);

  const result = importDirectory(args.dir, agent, { dryRun, recursive: args.recursive || false });
  console.log(`${result.files} files processed.`);

  for (const r of result.results) {
    if (r.imported) console.log(`  ✓ ${r.file?.split('/').pop()}: ${r.sections || 1} sections, ${r.chunks || 1} chunks`);
    else if (r.dryRun) console.log(`  → ${r.file?.split('/').pop()}: ${r.sections || '?'} sections`);
    else if (r.reason) console.log(`  ⚠ ${r.reason}`);
  }
}

// ── Arg parser ──────────────────────────────────────────

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file' && argv[i + 1]) result.file = argv[++i];
    else if (argv[i] === '--dir' && argv[i + 1]) result.dir = argv[++i];
    else if (argv[i] === '--agent' && argv[i + 1]) result.agent = argv[++i];
    else if (argv[i] === '--tier' && argv[i + 1]) result.tier = argv[++i];
    else if (argv[i] === '--auto-tier') result['auto-tier'] = true;
    else if (argv[i] === '--always-load') result['always-load'] = true;
    else if (argv[i] === '--dry-run') result['dry-run'] = true;
    else if (argv[i] === '--status') result.status = true;
    else if (argv[i] === '--recursive') result.recursive = true;
  }
  return result;
}
