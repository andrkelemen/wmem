#!/usr/bin/env node
/**
 * backfill-scopes.mjs — one-shot historical attribution pass.
 *
 * Scans existing chunks for absolute-path mentions in content, matches them
 * against registered project_scope_paths prefixes, and inserts session_files
 * rows with chunk_id already set. Idempotent: existing session_files rows for
 * the same (session_id, path, operation, chunk_id) tuple are skipped.
 *
 * Usage:
 *   node scripts/backfill-scopes.mjs                 # process all chunks
 *   node scripts/backfill-scopes.mjs --agent myapp   # filter to one agent
 *   node scripts/backfill-scopes.mjs --session X     # filter to one session
 *   node scripts/backfill-scopes.mjs --dry-run       # show, don't write
 */

import { getDb } from '../core/db.mjs';
import { normalizePath } from '../core/scopes.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') out.agent = argv[++i];
    else if (a === '--session') out.session = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: backfill-scopes.mjs [--agent NAME] [--session ID] [--dry-run]`);
  process.exit(0);
}

const db = getDb();

// Load all registered scope prefixes, ordered longest-first for match priority.
const prefixes = db.prepare(`
  SELECT scope, path_prefix FROM project_scope_paths
  ORDER BY LENGTH(path_prefix) DESC
`).all();

if (prefixes.length === 0) {
  console.error('No scope paths registered. Call project_scope_path_upsert first.');
  process.exit(1);
}

console.error(`[backfill] ${prefixes.length} path prefix(es) registered`);

// Absolute-path regex: captures windows (C:/... or C:\...), unix (/...), and
// scope-relative ("scope:path/") forms. We only care about absolute here since
// scope-relative mentions wouldn't need backfill (they'd already be tagged).
const PATH_RE = /([A-Za-z]:[\\\/][^\s"'`<>]+|\/[^\s"'`<>]+)/g;

// Chunks to scan
const where = [];
const params = [];
if (args.agent) { where.push('agent = ?'); params.push(args.agent); }
if (args.session) { where.push('session_id = ?'); params.push(args.session); }
let sql = 'SELECT id, session_id, content FROM chunks';
if (where.length) sql += ' WHERE ' + where.join(' AND ');
sql += ' ORDER BY id';

const chunks = db.prepare(sql).all(...params);
console.error(`[backfill] scanning ${chunks.length} chunk(s)`);

// Existing session_files rows we'd collide with — pre-fetch keys for fast skip
const existing = new Set(
  db.prepare("SELECT session_id || '\u001f' || path || '\u001f' || COALESCE(chunk_id, 0) AS k FROM session_files").all()
    .map(r => r.k)
);

const insert = db.prepare(`
  INSERT INTO session_files (session_id, chunk_id, scope, path, operation, occurred_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

let scanned = 0;
let written = 0;
let skippedDup = 0;
let noMatch = 0;

const tx = db.transaction((rows) => {
  for (const row of rows) {
    if (!row.content) continue;
    scanned++;
    const seen = new Set();
    let m;
    PATH_RE.lastIndex = 0;
    while ((m = PATH_RE.exec(row.content))) {
      const raw = m[1];
      if (raw.length < 5) continue; // reject tiny matches like "/x"
      if (seen.has(raw)) continue;
      seen.add(raw);

      const normalized = normalizePath(raw);
      // Longest-prefix match
      let scope = null;
      let relative = normalized;
      for (const p of prefixes) {
        if (normalized.startsWith(p.path_prefix)) {
          scope = p.scope;
          relative = normalized.slice(p.path_prefix.length);
          break;
        }
      }
      if (!scope) { noMatch++; continue; }

      const key = `${row.session_id || ''}\u001f${relative}\u001f${row.id}`;
      if (existing.has(key)) { skippedDup++; continue; }

      if (!args.dryRun) {
        insert.run(row.session_id, row.id, scope, relative, 'read', Date.now());
        existing.add(key);
      }
      written++;
    }
  }
});

tx(chunks);

console.error(`[backfill] scanned=${scanned} written=${written} skipped_dup=${skippedDup} no_match=${noMatch}${args.dryRun ? ' (dry-run)' : ''}`);
process.exit(0);
