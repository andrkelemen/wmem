/**
 * mail.mjs — inter-agent messaging.
 *
 * Table: messages (migrations/0004). Functions here handle:
 *   sendMessage    — write a new message (top-level or reply)
 *   getInbox       — list messages addressed TO an agent (unread filter optional)
 *   getOutbox      — list messages sent FROM an agent
 *   markRead       — mark a single message read
 *   threadMessages — walk the parent_id chain from root to leaves
 *
 * Caller identity comes from the transport layer (HTTP X-Caller or MCP
 * WMEM_CALLER env var). This module accepts `from` explicitly — callers
 * stamp it themselves. The transport wrapper is where identity resolution
 * lives; mail.mjs stays transport-agnostic.
 *
 * metadata is loose JSON. Conventions:
 *   source          — legacy-jsonl | direct-api | proxy-from-4004 | mcp-tool
 *   delivery_status — sent | received | failed (optional)
 *   thread_depth    — cached chain depth for fast "how deep" queries
 * Anything audit-worthy goes in a separate audit_log table later, not here.
 */

import { getDb } from './db.mjs';

// ───────────────────────────────────────────────────────────
// send
// ───────────────────────────────────────────────────────────

/**
 * Send a message from one agent to another.
 *
 * @param {object} args
 * @param {string} args.from - sender agent_id (required; caller-resolved upstream)
 * @param {string} args.to - recipient agent_id
 * @param {string} args.body - message body
 * @param {string} [args.subject]
 * @param {number} [args.parentId] - reply target; sets thread lineage
 * @param {object} [args.metadata] - loose JSON; see module header for conventions
 * @returns {{ id: number, threadDepth: number }}
 */
export function sendMessage({ from, to, body, subject = null, parentId = null, metadata = null }) {
  const db = getDb();

  // Agent validation — fail loud on typos
  const existsAgent = db.prepare('SELECT 1 FROM agents WHERE id = ?');
  if (!existsAgent.get(from)) throw new Error(`unknown from_agent: ${from}`);
  if (!existsAgent.get(to))   throw new Error(`unknown to_agent: ${to}`);

  // Thread depth: parent's depth + 1, or 0 for a root message
  let threadDepth = 0;
  if (parentId != null) {
    const parent = db.prepare('SELECT metadata FROM messages WHERE id = ?').get(parentId);
    if (!parent) throw new Error(`unknown parent_id: ${parentId}`);
    try {
      const parentMeta = parent.metadata ? JSON.parse(parent.metadata) : {};
      threadDepth = (parentMeta.thread_depth ?? 0) + 1;
    } catch {
      threadDepth = 1; // parent had bad metadata JSON; still valid reply
    }
  }

  const meta = { ...(metadata || {}), thread_depth: threadDepth };
  const metaJson = JSON.stringify(meta);

  const res = db.prepare(`
    INSERT INTO messages (from_agent, to_agent, subject, body, parent_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(from, to, subject, body, parentId, metaJson);

  return { id: Number(res.lastInsertRowid), threadDepth };
}

/**
 * Reply to a message — sugar over sendMessage that auto-resolves the
 * recipient from the parent message's `from` field. The caller still
 * stamps `from` themselves (same spoof-impossible property as sendMessage).
 *
 * @param {object} args
 * @param {string} args.from - sender agent_id (caller-resolved upstream)
 * @param {number} args.parentId - message id being replied to
 * @param {string} args.body
 * @param {string} [args.subject]
 * @param {object} [args.metadata]
 * @returns {{ id: number, threadDepth: number, to: string }}
 */
export function replyMessage({ from, parentId, body, subject = null, metadata = null }) {
  if (!from) throw new Error('from required');
  if (parentId == null) throw new Error('parentId required');
  if (!body) throw new Error('body required');
  const db = getDb();
  const parent = db.prepare('SELECT from_agent FROM messages WHERE id = ?').get(parentId);
  if (!parent) throw new Error(`unknown parent_id: ${parentId}`);
  const to = parent.from_agent;
  const res = sendMessage({ from, to, body, subject, parentId, metadata });
  return { ...res, to };
}

// ───────────────────────────────────────────────────────────
// inbox / outbox
// ───────────────────────────────────────────────────────────

export function getInbox(agent, { unreadOnly = false, limit = 100, since = null } = {}) {
  const db = getDb();
  const where = ['to_agent = ?'];
  const params = [agent];
  if (unreadOnly) where.push('read = 0');
  if (since != null) { where.push('timestamp > ?'); params.push(since); }
  const sql = `
    SELECT id, from_agent, to_agent, subject, body, timestamp, read, read_at, parent_id, metadata
    FROM messages
    WHERE ${where.join(' AND ')}
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `;
  params.push(limit);
  return db.prepare(sql).all(...params).map(parseMetadata);
}

export function getOutbox(agent, { limit = 100 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT id, from_agent, to_agent, subject, body, timestamp, read, read_at, parent_id, metadata
    FROM messages
    WHERE from_agent = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `).all(agent, limit).map(parseMetadata);
}

export function getMessage(id) {
  const row = getDb().prepare(`
    SELECT id, from_agent, to_agent, subject, body, timestamp, read, read_at, parent_id, metadata
    FROM messages WHERE id = ?
  `).get(id);
  return row ? parseMetadata(row) : null;
}

// ───────────────────────────────────────────────────────────
// read state
// ───────────────────────────────────────────────────────────

/**
 * Mark a message read. Idempotent — already-read stays read, read_at not overwritten.
 * @returns {{ id: number, marked: boolean }} marked=false if already read or missing
 */
export function markRead(id) {
  const db = getDb();
  const res = db.prepare(`
    UPDATE messages SET read = 1, read_at = unixepoch() * 1000
    WHERE id = ? AND read = 0
  `).run(id);
  return { id, marked: res.changes > 0 };
}

export function markUnread(id) {
  const db = getDb();
  const res = db.prepare(`
    UPDATE messages SET read = 0, read_at = NULL WHERE id = ? AND read = 1
  `).run(id);
  return { id, marked: res.changes > 0 };
}

// ───────────────────────────────────────────────────────────
// threading
// ───────────────────────────────────────────────────────────

/**
 * Walk the thread containing the given message id. Returns root → leaves
 * ordered by (timestamp, id). A thread is a connected component across
 * parent_id references.
 *
 * Implementation: find root (walk up via parent_id until NULL), then
 * recursive CTE downward to collect all descendants.
 */
export function threadMessages(anyMessageId) {
  const db = getDb();
  // Walk up to root
  let rootId = anyMessageId;
  let row = db.prepare('SELECT id, parent_id FROM messages WHERE id = ?').get(rootId);
  if (!row) return [];
  while (row.parent_id != null) {
    rootId = row.parent_id;
    row = db.prepare('SELECT id, parent_id FROM messages WHERE id = ?').get(rootId);
    if (!row) break;
  }
  // Walk down via recursive CTE
  const sql = `
    WITH RECURSIVE thread(id) AS (
      SELECT id FROM messages WHERE id = ?
      UNION ALL
      SELECT m.id FROM messages m JOIN thread t ON m.parent_id = t.id
    )
    SELECT m.id, m.from_agent, m.to_agent, m.subject, m.body, m.timestamp, m.read, m.read_at, m.parent_id, m.metadata
    FROM thread JOIN messages m ON m.id = thread.id
    ORDER BY m.timestamp ASC, m.id ASC
  `;
  return db.prepare(sql).all(rootId).map(parseMetadata);
}

// ───────────────────────────────────────────────────────────
// counts (for health dashboard, rate limits, etc.)
// ───────────────────────────────────────────────────────────

export function countsByAgent() {
  return getDb().prepare(`
    SELECT a.id AS agent_id,
           COALESCE(inbox.total, 0) AS inbox_total,
           COALESCE(inbox.unread, 0) AS inbox_unread,
           COALESCE(outbox.total, 0) AS outbox_total
    FROM agents a
    LEFT JOIN (
      SELECT to_agent, COUNT(*) AS total, SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS unread
      FROM messages GROUP BY to_agent
    ) inbox ON inbox.to_agent = a.id
    LEFT JOIN (
      SELECT from_agent, COUNT(*) AS total FROM messages GROUP BY from_agent
    ) outbox ON outbox.from_agent = a.id
    ORDER BY a.id
  `).all();
}

/**
 * Cheap unread probe — inter-turn poll without fetching bodies.
 * Returns count + oldest sender + oldest timestamp. Intended for agents
 * to check "is there mail?" every tick; full inbox fetch only when
 * unread_count > 0.
 *
 * Implementation notes:
 * - Subquery uses (timestamp ASC, id ASC) so MIN(timestamp) in the outer
 *   query and the subquery's LIMIT 1 always pick the same row in a tie
 *   (tie-breaker discipline). Sub-ms ties are rare in practice since
 *   timestamp is unixepoch ms, but the tie-breaker is cheap.
 * - Uses idx_messages_to_unread (to_agent, read, timestamp) from migration
 *   0004 — covering index for the filter + the outer MIN(timestamp).
 *   Assumes per-agent unread stays small (typical agent inbox reality);
 *   if unread piles grow huge without a read-sweep, performance degrades.
 *
 * @param {string} agent
 * @returns {{ unread_count: number, oldest_from: string|null, oldest_ts: number|null }}
 */
export function pendingForAgent(agent) {
  if (!agent) throw new Error('agent required');
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS unread_count,
           MIN(timestamp) AS oldest_ts,
           (SELECT from_agent FROM messages
             WHERE to_agent = ? AND read = 0
             ORDER BY timestamp ASC, id ASC LIMIT 1) AS oldest_from
      FROM messages
     WHERE to_agent = ? AND read = 0
  `).get(agent, agent);
  return {
    unread_count: row.unread_count ?? 0,
    oldest_from: row.oldest_from ?? null,
    oldest_ts: row.oldest_ts ?? null,
  };
}

// ───────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────

function parseMetadata(row) {
  if (row.metadata) {
    try { row.metadata = JSON.parse(row.metadata); }
    catch { /* leave as string if malformed */ }
  }
  return row;
}
