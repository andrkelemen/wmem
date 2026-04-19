/**
 * agents.mjs — DB layer for agent identity, personality facts, preferences.
 *
 * Tables live in migrations/0001_agent_tables.sql. This module exposes the
 * functions the MCP tools and the SessionEnd hook use to read/write those
 * tables. Zero-LLM: all writes come from callers (agents via MCP, or the
 * regex extractor writing signals).
 *
 * Terminology:
 *   signal  — tier 1, raw regex extraction, lives in preference_signals
 *   pref    — tier 2, agent-consolidated, lives in agent_preferences
 *   fact    — tier 3, repeated-pref promoted, lives in agent_personality_facts
 */

import { getDb } from './db.mjs';

// ───────────────────────────────────────────────────────────
// agents
// ───────────────────────────────────────────────────────────

export function listAgents() {
  return getDb().prepare('SELECT * FROM agents ORDER BY id').all();
}

export function getAgent(id) {
  return getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id);
}

/**
 * Insert or update an agent. Upsert by id.
 * @param {{ id: string, name: string, role?: string, metadata?: object }} agent
 */
export function upsertAgent({ id, name, role = null, metadata = null }) {
  const db = getDb();
  const meta = metadata ? JSON.stringify(metadata) : null;
  const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(id);
  if (existing) {
    db.prepare('UPDATE agents SET name = ?, role = ?, metadata = ? WHERE id = ?')
      .run(name, role, meta, id);
    return { id, updated: true };
  }
  db.prepare('INSERT INTO agents (id, name, role, metadata) VALUES (?, ?, ?, ?)')
    .run(id, name, role, meta);
  return { id, created: true };
}

// ───────────────────────────────────────────────────────────
// preferences (tier 2)
// ───────────────────────────────────────────────────────────

/**
 * Write a new preference row. Append-only — multiple calls for the same
 * (agent_id, key) create distinct rows. Tier 3 consolidation merges.
 *
 * @param {object} args
 * @param {string} args.agentId - subject of the preference
 * @param {string} args.key
 * @param {string} [args.value]
 * @param {number} [args.signalStrength] - -1.0 to +1.0
 * @param {string} [args.signalType] - liked | disliked | neutral | boundary
 * @param {number} [args.sourceChunkId]
 * @param {object} [args.metadata]
 * @param {string[]} [args.relations] - object_agent_ids this preference targets
 * @returns {{ id: number, relations: string[] }}
 */
export function writePreference({
  agentId, key, value = null, signalStrength = 0, signalType = 'neutral',
  sourceChunkId = null, metadata = null, relations = [],
}) {
  const db = getDb();

  // Validate agent exists to surface typos early
  if (!db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId)) {
    throw new Error(`unknown agent: ${agentId}`);
  }

  const meta = metadata ? JSON.stringify(metadata) : null;
  const res = db.prepare(`
    INSERT INTO agent_preferences
      (agent_id, key, value, signal_strength, signal_type, source_chunk_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(agentId, key, value, signalStrength, signalType, sourceChunkId, meta);
  const id = Number(res.lastInsertRowid);

  const accepted = [];
  if (relations && relations.length) {
    const insertRel = db.prepare(
      'INSERT OR IGNORE INTO agent_preference_relations (preference_id, object_agent_id) VALUES (?, ?)'
    );
    const hasAgent = db.prepare('SELECT 1 FROM agents WHERE id = ?');
    for (const targetId of relations) {
      if (!hasAgent.get(targetId)) continue; // silently skip unknowns
      insertRel.run(id, targetId);
      accepted.push(targetId);
    }
  }

  return { id, relations: accepted };
}

/**
 * List preferences with optional filters.
 * @param {object} opts
 * @param {string} [opts.agentId] - subject filter
 * @param {string} [opts.signalType] - liked | disliked | neutral | boundary
 * @param {string} [opts.key]
 * @param {string} [opts.objectAgentId] - relations filter (prefs ABOUT this agent)
 * @param {number} [opts.limit=100]
 * @param {boolean} [opts.includeAnchors=false] - inline top-N anchors per row
 * @param {number} [opts.anchorLimit=5] - anchors per row when includeAnchors=true
 */
export function listPreferences({ agentId, signalType, key, objectAgentId, limit = 100, includeAnchors = false, anchorLimit = 5 } = {}) {
  const db = getDb();
  const where = [];
  const params = [];

  if (agentId) { where.push('p.agent_id = ?'); params.push(agentId); }
  if (signalType) { where.push('p.signal_type = ?'); params.push(signalType); }
  if (key) { where.push('p.key = ?'); params.push(key); }

  let sql = `
    SELECT p.*,
           (SELECT json_group_array(object_agent_id)
            FROM agent_preference_relations r
            WHERE r.preference_id = p.id) AS relations_json
    FROM agent_preferences p
  `;
  if (objectAgentId) {
    sql += ` INNER JOIN agent_preference_relations r ON r.preference_id = p.id AND r.object_agent_id = ? `;
    params.push(objectAgentId);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY p.updated_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  const preferences = rows.map(r => ({
    ...r,
    relations: r.relations_json ? JSON.parse(r.relations_json).filter(Boolean) : [],
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
  })).map(({ relations_json, ...rest }) => rest);

  if (includeAnchors && preferences.length) {
    const anchorStmt = db.prepare(`
      SELECT * FROM preference_anchors
      WHERE preference_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `);
    for (const p of preferences) {
      p.anchors = anchorStmt.all(p.id, anchorLimit);
    }
  }

  return preferences;
}

// ───────────────────────────────────────────────────────────
// preference anchors — evidence linking preferences to chunks
// ───────────────────────────────────────────────────────────

const VALID_VALENCES = new Set(['reinforces', 'contradicts', 'refines']);

/**
 * Write an anchor linking a preference to a chunk of evidence.
 *
 * @param {object} args
 * @param {number} args.preferenceId - agent_preferences.id
 * @param {number} [args.chunkId] - chunks.id (optional but recommended)
 * @param {string} args.valence - reinforces | contradicts | refines
 * @param {string} [args.annotation] - short why-this-anchors-this line
 * @returns {{ id: number }}
 */
export function writeAnchor({ preferenceId, chunkId = null, valence, annotation = null }) {
  if (!VALID_VALENCES.has(valence)) {
    throw new Error(`invalid valence: ${valence} (must be reinforces | contradicts | refines)`);
  }
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM agent_preferences WHERE id = ?').get(preferenceId)) {
    throw new Error(`unknown preference_id: ${preferenceId}`);
  }
  const res = db.prepare(`
    INSERT INTO preference_anchors (preference_id, chunk_id, valence, annotation)
    VALUES (?, ?, ?, ?)
  `).run(preferenceId, chunkId, valence, annotation);
  return { id: Number(res.lastInsertRowid) };
}

/**
 * List anchors for a preference, newest first by default.
 */
export function listAnchors({ preferenceId, limit = 20, newestFirst = true } = {}) {
  if (!preferenceId) throw new Error('preferenceId required');
  const db = getDb();
  const order = newestFirst ? 'DESC' : 'ASC';
  // id is the deterministic tiebreaker — multiple anchors written in the
  // same millisecond otherwise come back in non-deterministic order.
  return db.prepare(`
    SELECT * FROM preference_anchors
    WHERE preference_id = ?
    ORDER BY created_at ${order}, id ${order}
    LIMIT ?
  `).all(preferenceId, limit);
}

// ───────────────────────────────────────────────────────────
// facts (tier 3)
// ───────────────────────────────────────────────────────────

export function writeFact({ agentId, category = null, fact, confidence = 0.5, sourceChunkId = null }) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId)) {
    throw new Error(`unknown agent: ${agentId}`);
  }
  const res = db.prepare(`
    INSERT INTO agent_personality_facts (agent_id, category, fact, confidence, source_chunk_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentId, category, fact, confidence, sourceChunkId);
  return { id: Number(res.lastInsertRowid) };
}

export function listFacts({ agentId, category, limit = 100 } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (agentId) { where.push('agent_id = ?'); params.push(agentId); }
  if (category) { where.push('category = ?'); params.push(category); }
  let sql = 'SELECT * FROM agent_personality_facts';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY confidence DESC, created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// ───────────────────────────────────────────────────────────
// preference_review_queue (tier 2 trigger)
// ───────────────────────────────────────────────────────────

/**
 * SessionEnd calls this to enqueue a session for preference consolidation.
 * Silently idempotent — same session_id is replaced, not duplicated.
 */
export function enqueueReview({ sessionId, agentId = null, chunkCount = null }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO preference_review_queue (session_id, agent_id, chunk_count, enqueued_at)
    VALUES (?, ?, ?, unixepoch() * 1000)
    ON CONFLICT(session_id) DO UPDATE SET
      agent_id = excluded.agent_id,
      chunk_count = excluded.chunk_count,
      enqueued_at = excluded.enqueued_at,
      claimed_at = NULL,
      claimed_by = NULL
  `).run(sessionId, agentId, chunkCount);
  return { sessionId, enqueued: true };
}

/**
 * List pending review tasks. By default returns only unclaimed ones.
 */
export function listPendingReviews({ unclaimedOnly = true, limit = 50 } = {}) {
  const db = getDb();
  const sql = unclaimedOnly
    ? 'SELECT * FROM preference_review_queue WHERE claimed_at IS NULL ORDER BY enqueued_at ASC LIMIT ?'
    : 'SELECT * FROM preference_review_queue ORDER BY enqueued_at ASC LIMIT ?';
  return db.prepare(sql).all(limit);
}

/**
 * Atomically claim a review task. Returns null if already claimed or missing.
 */
export function claimReview(sessionId, claimedBy) {
  const db = getDb();
  const res = db.prepare(`
    UPDATE preference_review_queue
    SET claimed_at = unixepoch() * 1000, claimed_by = ?
    WHERE session_id = ? AND claimed_at IS NULL
  `).run(claimedBy, sessionId);
  if (res.changes === 0) return null;
  return db.prepare('SELECT * FROM preference_review_queue WHERE session_id = ?').get(sessionId);
}

/**
 * Remove a session from the queue once the agent has written its consolidation.
 */
export function completeReview(sessionId) {
  const db = getDb();
  const res = db.prepare('DELETE FROM preference_review_queue WHERE session_id = ?').run(sessionId);
  return { sessionId, completed: res.changes > 0 };
}
