/**
 * Migration runner.
 *
 * Scans this directory for files matching NNNN_name.sql, checks the
 * schema_migrations table, applies any that haven't run yet in numeric order.
 * Idempotent: already-applied migrations are skipped.
 *
 * Failures mid-migration leave the schema_migrations table UNmarked for that
 * file, so the next run retries. Each .sql file should be a single
 * transaction — the migration either fully applies or fully doesn't.
 *
 * Usage from code:
 *   import { runMigrations } from './migrations/_runner.mjs';
 *   runMigrations(db);
 *
 * Usage from CLI:
 *   node migrations/_runner.mjs [db_path]
 */

import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIGRATION_RE = /^(\d{4})_[\w.-]+\.sql$/;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ quiet?: boolean, dir?: string }} [opts]
 * @returns {{ applied: string[], skipped: string[] }}
 */
export function runMigrations(db, { quiet = false, dir = __dirname } = {}) {
  // Bootstrap the tracking table. Intentionally inline so this runner
  // doesn't depend on 0000 existing — 0000's job is to document the shape.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const files = readdirSync(dir)
    .filter(f => MIGRATION_RE.test(f))
    .sort();

  const applied = [];
  const skipped = [];
  const log = quiet ? () => {} : (...a) => console.error('[migrate]', ...a);

  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE filename = ?');
  const markApplied = db.prepare('INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (isApplied.get(file)) {
      skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    log(`applying ${file}`);
    try {
      db.exec(sql);
      markApplied.run(file, Date.now());
      applied.push(file);
    } catch (err) {
      log(`FAILED ${file}: ${err.message}`);
      throw err;
    }
  }

  if (applied.length) log(`applied ${applied.length} migration(s), skipped ${skipped.length}`);
  return { applied, skipped };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv[2] || process.env.MEMORY_DB || 'data/memory.db';
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  try {
    const res = runMigrations(db);
    console.error(`[migrate] done. applied=${res.applied.length} skipped=${res.skipped.length}`);
    process.exit(0);
  } catch (err) {
    console.error(`[migrate] error: ${err.message}`);
    process.exit(1);
  }
}
