// outbox.mjs — sqlite ops for the local outbox store.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

function defaultDbPath() {
  if (process.env.WMEM_OUTBOX_DB) return process.env.WMEM_OUTBOX_DB;
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || homedir(), 'wmem', 'outbox.db');
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'wmem', 'outbox.db');
}

export function openOutbox({ logger = console } = {}) {
  const dbPath = defaultDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });

  let db;
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
  } catch (err) {
    // corrupt db → rename + start fresh, do not silently lose data
    const corruptName = `${dbPath}.corrupt-${Date.now()}`;
    logger.error(`! outbox db corrupt at startup, renaming → ${corruptName}: ${err.message}`);
    if (existsSync(dbPath)) renameSync(dbPath, corruptName);
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
  }

  // apply migrations idempotently
  const migrations = ['001_initial.sql'];
  for (const file of migrations) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.exec(sql);
  }

  const stmts = {
    insert: db.prepare(`
      INSERT INTO outbox (created_at, endpoint, method, headers_json, payload, payload_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    pendingForDrain: db.prepare(`
      SELECT * FROM outbox
       WHERE status = 'pending'
         AND (last_attempt_at IS NULL OR ? - last_attempt_at >= ?)
       ORDER BY id
       LIMIT ?
    `),
    deleteById: db.prepare('DELETE FROM outbox WHERE id = ?'),
    markRetry: db.prepare(`
      UPDATE outbox
         SET retry_count = retry_count + 1,
             last_error = ?,
             last_attempt_at = ?
       WHERE id = ?
    `),
    markDeadLetter: db.prepare(`
      UPDATE outbox
         SET status = 'dead-letter',
             retry_count = retry_count + 1,
             last_error = ?,
             last_attempt_at = ?
       WHERE id = ?
    `),
    countByStatus: db.prepare(`
      SELECT status, COUNT(*) AS c FROM outbox GROUP BY status
    `),
    listPending: db.prepare(`
      SELECT id, endpoint, method, retry_count, last_error,
             created_at, last_attempt_at, status
        FROM outbox WHERE status = 'pending' ORDER BY id
    `),
    listDeadLetter: db.prepare(`
      SELECT id, endpoint, method, retry_count, last_error,
             created_at, last_attempt_at, status
        FROM outbox WHERE status = 'dead-letter' ORDER BY id
    `),
    purgeDeadLetter: db.prepare(`DELETE FROM outbox WHERE status = 'dead-letter'`),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
  };

  return {
    dbPath,
    db,
    enqueue({ endpoint, method, headers, payload, payloadType }) {
      const info = stmts.insert.run(
        Date.now(),
        endpoint,
        method,
        JSON.stringify(headers ?? {}),
        Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', 'utf8'),
        payloadType ?? 'application/octet-stream'
      );
      return info.lastInsertRowid;
    },
    eligibleForDrain({ baseBackoffS = 30, batch = 25 }) {
      // exponential backoff is enforced in JS — pull all status=pending and
      // filter by `now - last_attempt_at > 2^retry_count * baseBackoffS`.
      // SQL-side filter only uses min-backoff (baseBackoffS) so a fresh
      // never-attempted row always passes. JS post-filter handles per-row
      // backoff per retry_count.
      const rows = stmts.pendingForDrain.all(Date.now(), 0, batch * 4);
      const now = Date.now();
      const out = [];
      for (const r of rows) {
        if (r.last_attempt_at == null) { out.push(r); }
        else {
          const waitMs = Math.pow(2, r.retry_count) * baseBackoffS * 1000;
          if (now - r.last_attempt_at >= waitMs) out.push(r);
        }
        if (out.length >= batch) break;
      }
      return out;
    },
    deleteRow(id) { stmts.deleteById.run(id); },
    markRetry(id, errMsg) { stmts.markRetry.run(errMsg ?? null, Date.now(), id); },
    markDeadLetter(id, errMsg) { stmts.markDeadLetter.run(errMsg ?? null, Date.now(), id); },
    stats() {
      const counts = { pending: 0, 'dead-letter': 0 };
      for (const r of stmts.countByStatus.all()) counts[r.status] = r.c;
      return counts;
    },
    listPending() { return stmts.listPending.all(); },
    listDeadLetter() { return stmts.listDeadLetter.all(); },
    purgeDeadLetter() {
      const info = stmts.purgeDeadLetter.run();
      return info.changes;
    },
    getMeta(key) { return stmts.getMeta.get(key)?.value ?? null; },
    setMeta(key, value) { stmts.setMeta.run(key, String(value)); },
    close() { db.close(); },
  };
}
