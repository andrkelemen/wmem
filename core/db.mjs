/**
 * db.mjs — SQLite message store + FTS5 full-text search + vector semantic search
 *
 * Schema:
 *   chunks — indexed text content (JSONL messages, memory chunks, identity files)
 *   chunks_fts — FTS5 virtual table over chunks.content for keyword search
 *   chunks_vec — vec0 virtual table for semantic vector search (sqlite-vec)
 *
 * Every row has an agent partition column so searches can filter per-agent or search all.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';
import * as childProcess from 'child_process';
import { generateTags } from './autotag.mjs';
import { extractQueryFacets, scoreChunkAgainstFacets } from './facets.mjs';
import { runMigrations } from '../migrations/_runner.mjs';
import { backfillChunkIdForSession } from './scopes.mjs';

const DB_PATH = process.env.MEMORY_DB || './data/memory.db';

let db = null;

export function getDb() {
  if (db) return db;

  // Ensure directory exists
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Main content table
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT,
      session_id TEXT,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      metadata TEXT,
      content_hash TEXT,
      privacy TEXT NOT NULL DEFAULT 'private'
    )
  `);
  // privacy: 'private' (only this personality), 'shared' (all see it), 'personal' (locked, cannot be shared)

  // FTS5 virtual table for full-text search over content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      content='chunks',
      content_rowid='id',
      tokenize='porter unicode61'
    )
  `);

  // Triggers to keep FTS5 in sync with chunks table
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
      INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);

  // Index for fast filtering by agent + source_type
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_agent ON chunks(agent)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash, agent, source_type, session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_timestamp ON chunks(timestamp)`);

  // Sessions table — tracks JSONL files and incremental indexing state
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      file_path TEXT NOT NULL,
      agent TEXT NOT NULL DEFAULT 'default',
      file_size INTEGER NOT NULL DEFAULT 0,
      last_byte_offset INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      first_timestamp INTEGER,
      last_timestamp INTEGER,
      last_indexed_at INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent)`);

  // Session bookmarks — auto-indexed summaries for "where did we leave off?"
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      directory TEXT,
      project_name TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      duration INTEGER,
      summary TEXT,
      files_touched TEXT,
      chunks_indexed INTEGER DEFAULT 0,
      tags TEXT,
      metadata TEXT,
      UNIQUE(session_id, agent, directory)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bookmarks_agent ON session_bookmarks(agent)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bookmarks_time ON session_bookmarks(ended_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bookmarks_project ON session_bookmarks(project_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bookmarks_dir ON session_bookmarks(directory)`);

  // Knowledge graph relations — unified node-to-node edges
  // Node types: topic, directory, project, agent
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source TEXT NOT NULL,
      relation TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      session_count INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kg_source ON kg_relations(source_type, source)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kg_target ON kg_relations(target_type, target)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_edge ON kg_relations(source_type, source, relation, target_type, target)`);

  // Agent aliases — map detected names to canonical agent names
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_aliases (
      alias TEXT PRIMARY KEY,
      canonical TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Vector embeddings table — sqlite-vec, same DB file
  // Links to chunks via rowid = chunks.id
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[384])`);

  // Preference signals — multidimensional preference extraction
  // subject + context + sentiment, aggregated at query time via GROUP BY
  db.exec(`
    CREATE TABLE IF NOT EXISTS preference_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      domain TEXT,
      subject TEXT NOT NULL,
      context TEXT,
      sentiment REAL,
      raw_text TEXT,
      session_id TEXT,
      chunk_id INTEGER,
      created_at INTEGER,
      FOREIGN KEY (chunk_id) REFERENCES chunks(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pref_agent_domain ON preference_signals(agent, domain)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pref_subject ON preference_signals(agent, subject)`);

  // Facts table — extracted user self-statements, queried directly for preference questions
  // Separate from chunks to avoid polluting FTS5 candidate pool
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      source_chunk_id INTEGER,
      session_id TEXT,
      timestamp INTEGER,
      FOREIGN KEY (source_chunk_id) REFERENCES chunks(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_agent ON facts(agent)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_session ON facts(session_id)`);

  // Tags table — auto-generated topic tags per chunk
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      FOREIGN KEY (chunk_id) REFERENCES chunks(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tags_chunk ON tags(chunk_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag)`);

  // Apply pending migrations. Idempotent — already-applied ones are skipped.
  // New tables (agents, agent_preferences, etc.) live in migrations/ rather
  // than inline, so the DB picks them up on next server start.
  try {
    runMigrations(db, { quiet: true });
  } catch (err) {
    console.error('[db] migration failed:', err.message);
    throw err;
  }

  return db;
}

/**
 * Insert a chunk into the store. Content-hash dedup: if a chunk with the same
 * hash exists for the same agent+source_type, skip the insert.
 */
export function insertChunk({ agent, sourceType, sourceId, sessionId, content, timestamp, metadata }) {
  const db = getDb();
  const hash = simpleHash(content);

  // Dedup check: same content in the same session = true duplicate.
  // Same content in different sessions = different context, keep both.
  const existing = db.prepare(
    'SELECT id FROM chunks WHERE content_hash = ? AND agent = ? AND source_type = ? AND session_id IS NOT DISTINCT FROM ?'
  ).get(hash, agent, sourceType, sessionId);
  if (existing) return { id: existing.id, deduped: true };

  const result = db.prepare(`
    INSERT INTO chunks (agent, source_type, source_id, session_id, content, timestamp, metadata, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(agent, sourceType, sourceId, sessionId, content, timestamp, metadata ? JSON.stringify(metadata) : null, hash);

  const chunkId = Number(result.lastInsertRowid);

  // Attribute any pending file activity for this session to the new chunk.
  // Tool calls happen during a turn; the chunk for that turn is written when
  // the turn completes. Backfilling here closes the loop systemically.
  if (sessionId) {
    try {
      backfillChunkIdForSession(sessionId, chunkId);
    } catch (err) {
      // Don't block chunk insert on backfill failure — log and continue.
      console.error('[db] backfillChunkIdForSession failed:', err.message);
    }
  }

  return { id: chunkId, deduped: false };
}

/**
 * Amend a chunk's content in place. For cleanup — e.g. a leaked API key
 * was indexed and the user wants it out without preserving the original.
 *
 * Replaces content, recomputes hash, regenerates tags, drops the vector.
 * FTS5 re-syncs automatically via the chunks_au trigger. The original
 * content is NOT preserved anywhere — this is a redaction, not a
 * revision history.
 *
 * @param {number} chunkId
 * @param {string} newContent - The replacement content (defaults to a redaction marker)
 * @param {string} [reason] - Optional reason recorded in metadata.amended_reason
 * @returns {{ amended: boolean, chunk?: object, reason?: string }}
 */
export function amendChunk(chunkId, newContent, reason = null) {
  const db = getDb();
  const chunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId);
  if (!chunk) return { amended: false, reason: 'chunk not found' };

  const newHash = simpleHash(newContent);
  const meta = chunk.metadata ? JSON.parse(chunk.metadata) : {};
  meta.amended_at = Date.now();
  if (reason) meta.amended_reason = reason;

  db.prepare('UPDATE chunks SET content = ?, content_hash = ?, metadata = ? WHERE id = ?')
    .run(newContent, newHash, JSON.stringify(meta), chunkId);

  // Regenerate tags from new content
  db.prepare('DELETE FROM tags WHERE chunk_id = ?').run(chunkId);
  // Drop vector — redacted content is worthless to embed. If the user runs
  // `reimport steps=embeddings` later, an embedding for the new content will
  // be generated if it passes the length threshold.
  try { db.prepare('DELETE FROM chunks_vec WHERE rowid = ?').run(BigInt(chunkId)); } catch { }

  return { amended: true, chunk: { ...chunk, content: newContent, content_hash: newHash } };
}

/**
 * FTS5 keyword search. Returns matching chunks ranked by relevance.
 *
 * Scope controls visibility across personality partitions:
 *   'default' — shared + active personality's private (most common)
 *   'private' — only active personality's private chunks
 *   'shared'  — only _shared chunks
 *   'all'     — everything across all personalities (explicit opt-in)
 */
export function search(query, { agent, sourceType, scope = 'default', limit = 20, tagBoost = true } = {}) {
  const db = getDb();

  // Auto-convert multi-word queries to OR when no explicit operators
  // FTS5 defaults to AND which is too strict for recall-style queries
  // "blindfold gag chain" → "blindfold OR gag OR chain"
  const hasOperator = /\b(AND|OR|NOT)\b|"/.test(query);
  const ftsQuery = hasOperator ? query : query.trim().split(/\s+/).join(' OR ');

  // Fetch 2x candidates when tag-boosting so re-sort has room to work.
  const fetchLimit = tagBoost ? limit * 2 : limit;

  let sql = `
    SELECT c.id, c.agent, c.source_type, c.source_id, c.session_id,
           c.content, c.timestamp, c.metadata, c.privacy,
           rank,
           snippet(chunks_fts, 0, '>>>', '<<<', '...', 40) as snippet
    FROM chunks_fts f
    JOIN chunks c ON c.id = f.rowid
    WHERE chunks_fts MATCH ?
  `;
  const params = [ftsQuery];

  // Scope filtering
  if (scope === 'default' && agent) {
    sql += " AND (c.agent = ? OR c.agent = '_shared')";
    params.push(agent);
  } else if (scope === 'private' && agent) {
    sql += ' AND c.agent = ?';
    params.push(agent);
  } else if (scope === 'shared') {
    sql += " AND c.agent = '_shared'";
  } else if (scope === 'all') {
    // no agent filter — but exclude personal chunks from other personalities
    if (agent) {
      sql += " AND (c.privacy != 'personal' OR c.agent = ?)";
      params.push(agent);
    }
  } else if (agent) {
    sql += ' AND c.agent = ?';
    params.push(agent);
  }

  if (sourceType) {
    sql += ' AND c.source_type = ?';
    params.push(sourceType);
  }

  sql += ' ORDER BY rank LIMIT ?';
  params.push(fetchLimit);

  const results = db.prepare(sql).all(...params);

  if (!tagBoost || results.length === 0) return results.slice(0, limit);

  return applyTagBoost(db, query, results, limit);
}

/**
 * Re-rank FTS5 results by tag overlap with the query.
 *
 * Uses autotag.generateTags on the query to derive topic/action tags,
 * then boosts chunks whose stored tags match. Pure SQL + in-memory merge
 * — no model call, no new indexes.
 *
 * Boost formula: boostedRank = |rank| * (1 + TAG_BOOST_WEIGHT * tagScore)
 * where tagScore = sum(query_tag_confidence * chunk_tag_confidence)
 *
 * Chunks with no tag overlap keep their FTS5 rank unchanged (boost=1.0).
 */
const TAG_BOOST_WEIGHT = 0.3;

function applyTagBoost(db, query, results, limit) {
  const queryTags = generateTags(query);
  if (queryTags.length === 0) return results.slice(0, limit);

  const chunkIds = results.map(r => r.id);
  const placeholders = chunkIds.map(() => '?').join(',');
  const tagRows = db.prepare(
    `SELECT chunk_id, tag, confidence FROM tags WHERE chunk_id IN (${placeholders})`
  ).all(...chunkIds);

  const queryTagConf = new Map(queryTags.map(t => [t.tag, t.confidence]));
  const tagScoreByChunk = new Map();

  for (const row of tagRows) {
    const qConf = queryTagConf.get(row.tag);
    if (qConf !== undefined) {
      const prev = tagScoreByChunk.get(row.chunk_id) || 0;
      tagScoreByChunk.set(row.chunk_id, prev + (row.confidence * qConf));
    }
  }

  return results
    .map(r => {
      const tagScore = tagScoreByChunk.get(r.id) || 0;
      const boostedRank = Math.abs(r.rank || 1) * (1 + TAG_BOOST_WEIGHT * tagScore);
      return { ...r, tagScore, boostedRank };
    })
    .sort((a, b) => b.boostedRank - a.boostedRank)
    .slice(0, limit);
}

/**
 * Semantic vector search via sqlite-vec.
 * Returns chunks ranked by cosine distance to the query embedding.
 */
export function vectorSearch(queryEmbedding, { agent, limit = 20 } = {}) {
  const db = getDb();

  // sqlite-vec returns rowids + distances; join to get full chunk data
  const vecResults = db.prepare(`
    SELECT rowid, distance FROM chunks_vec
    WHERE embedding MATCH ?
    ORDER BY distance LIMIT ?
  `).all(queryEmbedding, limit * 2); // fetch extra for post-filtering

  if (vecResults.length === 0) return [];

  const rowids = vecResults.map(r => r.rowid);
  const distMap = new Map(vecResults.map(r => [Number(r.rowid), r.distance]));

  // Fetch full chunk data for matched rowids
  const placeholders = rowids.map(() => '?').join(',');
  let sql = `SELECT * FROM chunks WHERE id IN (${placeholders})`;
  const params = [...rowids];

  if (agent) {
    sql += ' AND agent = ?';
    params.push(agent);
  }

  const chunks = db.prepare(sql).all(...params);

  // Attach distance and sort
  return chunks
    .map(c => ({ ...c, distance: distMap.get(c.id) || 1.0 }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

/**
 * Hybrid search: FTS5 keyword first, vector semantic fallback.
 * Merges results using weighted BM25 + cosine scores.
 *
 * @param {string} query - Search query text
 * @param {Float32Array} queryEmbedding - Pre-computed embedding (or null to skip vector)
 * @param {object} opts - { agent, limit, ftsWeight, vecWeight }
 */
export function hybridSearch(query, queryEmbedding, {
  agent,
  limit = 20,
  ftsWeight = 0.6,
  vecWeight = 0.4,
  userBoost = 1.5,
  facets = null,        // pre-extracted facet bundle; or pass `true` to auto-extract from query
  facetBoost = 0.6,     // additive weight on facet score (max facet score ≈ 2.3 — time+project+role only; topic/action already in applyTagBoost)
} = {}) {
  const db = getDb();
  const results = new Map(); // id → { chunk, score }

  // Resolve facets: pass `true` to auto-extract, an object to use as-is, or null/false to skip.
  let facetBundle = null;
  if (facets === true) {
    facetBundle = extractQueryFacets(query, { knownProjects: getKnownProjectNames(db) });
  } else if (facets && typeof facets === 'object') {
    facetBundle = facets;
  }

  // Position-based normalization — rank 0 → 1.0, rank N-1 → ~0.
  // Avoids SQLite BM25 (negative rank) and cosine-distance sign confusion:
  // both streams are already sorted best-first by their respective queries,
  // so position IS the signal.
  const posScore = (i, n) => 1 - (i / Math.max(n - 1, 1));

  // 1. FTS5 keyword search (results already sorted best-first by rank ASC)
  const ftsResults = search(query, { agent, limit: limit * 2 });

  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i];
    const boost = r.content?.startsWith('[user]') ? userBoost : 1.0;
    const score = posScore(i, ftsResults.length) * ftsWeight * boost;
    results.set(r.id, { chunk: r, score });
  }

  // 2. Vector semantic search (results already sorted best-first by distance ASC)
  if (queryEmbedding) {
    const vecResults = vectorSearch(queryEmbedding, { agent, limit: limit * 2 });

    for (let i = 0; i < vecResults.length; i++) {
      const r = vecResults[i];
      const boost = r.content?.startsWith('[user]') ? userBoost : 1.0;
      const score = posScore(i, vecResults.length) * vecWeight * boost;
      const existing = results.get(r.id);
      if (existing) {
        existing.score += score;
      } else {
        results.set(r.id, { chunk: r, score });
      }
    }
  }

  // 3. Optional facet boost — multi-axis pre-filter applied additively on top
  //    of the hybrid score. Additive (not multiplicative) so facet matches can
  //    still lift candidates whose position-normalized hybrid score is near
  //    zero. Not a hard filter, so recall stays safe.
  if (facetBundle) {
    const ids = Array.from(results.keys());
    if (ids.length > 0) {
      const ctx = buildFacetScoringCtx(db, ids);
      for (const r of results.values()) {
        const fs = scoreChunkAgainstFacets(r.chunk, ctx, facetBundle);
        r.facetScore = fs;
        r.score = r.score + facetBoost * fs;
      }
    }
  }

  // 4. Sort by combined score, return top results
  return Array.from(results.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => ({
      ...r.chunk,
      hybridScore: r.score,
      ...(r.facetScore !== undefined ? { facetScore: r.facetScore } : {}),
    }));
}

/**
 * Cached project-name list for facet extraction. Refreshed on each call
 * (cheap — projects table is small) so newly-named projects route correctly.
 */
function getKnownProjectNames(db) {
  const names = new Set();
  try {
    for (const r of db.prepare('SELECT DISTINCT name FROM projects').all()) names.add(r.name);
  } catch { /* projects table may not exist */ }
  try {
    for (const r of db.prepare(
      'SELECT DISTINCT project_name FROM session_bookmarks WHERE project_name IS NOT NULL'
    ).all()) names.add(r.project_name);
  } catch { /* session_bookmarks may not exist */ }
  return Array.from(names);
}

/**
 * Pre-load tags + session-project mapping for a candidate chunk-id set.
 * One query per facet axis; scoring then runs in-memory.
 */
function buildFacetScoringCtx(db, chunkIds) {
  const placeholders = chunkIds.map(() => '?').join(',');

  const tagRows = db.prepare(
    `SELECT chunk_id, tag, confidence FROM tags WHERE chunk_id IN (${placeholders})`
  ).all(...chunkIds);
  const chunkTagsById = new Map();
  for (const r of tagRows) {
    if (!chunkTagsById.has(r.chunk_id)) chunkTagsById.set(r.chunk_id, []);
    chunkTagsById.get(r.chunk_id).push({ tag: r.tag, confidence: r.confidence });
  }

  let chunkProjectById = new Map();
  try {
    const projRows = db.prepare(`
      SELECT c.id AS chunk_id, b.project_name
      FROM chunks c
      JOIN session_bookmarks b ON b.session_id = c.session_id AND b.agent = c.agent
      WHERE c.id IN (${placeholders}) AND b.project_name IS NOT NULL
    `).all(...chunkIds);
    chunkProjectById = new Map(projRows.map(r => [r.chunk_id, r.project_name]));
  } catch {
    // session_bookmarks may not exist in older DBs — facet still works without project.
  }

  return { chunkTagsById, chunkProjectById };
}

/**
 * Share a chunk across all personalities by copying it to _shared.
 * Respects privacy flag — 'personal' chunks cannot be shared.
 */
export function shareChunk(chunkId) {
  const db = getDb();
  const chunk = db.prepare('SELECT * FROM chunks WHERE id = ?').get(chunkId);
  if (!chunk) return { shared: false, reason: 'chunk not found' };
  if (chunk.privacy === 'personal') return { shared: false, reason: 'chunk is marked personal — cannot be shared' };
  if (chunk.agent === '_shared') return { shared: false, reason: 'already shared' };

  // Copy to _shared partition
  const result = insertChunk({
    agent: '_shared',
    sourceType: chunk.source_type,
    sourceId: chunk.source_id,
    sessionId: chunk.session_id,
    content: chunk.content,
    timestamp: chunk.timestamp,
    metadata: chunk.metadata ? JSON.parse(chunk.metadata) : null,
  });

  if (!result.deduped) {
    // Update privacy on the new shared copy
    db.prepare("UPDATE chunks SET privacy = 'shared' WHERE id = ?").run(result.id);
  }

  return { shared: true, newId: result.id, deduped: result.deduped };
}

/**
 * Mark a chunk as personal (locked to its personality, cannot be shared).
 */
export function markPersonal(chunkId) {
  const db = getDb();
  const result = db.prepare("UPDATE chunks SET privacy = 'personal' WHERE id = ?").run(chunkId);
  return { marked: result.changes > 0 };
}

/**
 * Insert a vector embedding for a chunk.
 */
export function insertEmbedding(chunkId, embedding) {
  const db = getDb();
  try {
    db.prepare('INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)').run(BigInt(chunkId), embedding);
    return { inserted: true };
  } catch (err) {
    // Duplicate rowid — already embedded
    if (err.code === 'SQLITE_CONSTRAINT') return { inserted: false, duplicate: true };
    throw err;
  }
}

/**
 * Insert tags for a chunk.
 */
export function insertTags(chunkId, tags) {
  const db = getDb();
  const stmt = db.prepare('INSERT INTO tags (chunk_id, tag, confidence) VALUES (?, ?, ?)');
  for (const { tag, confidence = 1.0 } of tags) {
    stmt.run(chunkId, tag, confidence);
  }
}

/**
 * Search by tag.
 */
export function searchByTag(tag, { agent, limit = 20 } = {}) {
  const db = getDb();
  let sql = `
    SELECT c.*, t.tag, t.confidence
    FROM tags t JOIN chunks c ON c.id = t.chunk_id
    WHERE t.tag = ?
  `;
  const params = [tag];
  if (agent) { sql += ' AND c.agent = ?'; params.push(agent); }
  sql += ' ORDER BY c.timestamp DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

/**
 * Get all unique tags with counts.
 */
export function getAllTags() {
  const db = getDb();
  return db.prepare('SELECT tag, COUNT(*) as count FROM tags GROUP BY tag ORDER BY count DESC').all();
}

/**
 * Get recent chunks for a agent, ordered by timestamp descending.
 */
export function getRecent(agent, { sourceType, limit = 50 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM chunks WHERE agent = ?';
  const params = [agent];
  if (sourceType) {
    sql += ' AND source_type = ?';
    params.push(sourceType);
  }
  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

/**
 * Get stats for monitoring.
 */
export function getStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM chunks').get();
  const byAgent = db.prepare('SELECT agent, COUNT(*) as count FROM chunks GROUP BY agent').all();
  const byType = db.prepare('SELECT source_type, COUNT(*) as count FROM chunks GROUP BY source_type').all();
  return { total: total.count, byAgent, byType };
}

// Simple string hash for dedup (not cryptographic, just collision-resistant enough)
function simpleHash(str) {
  // Normalize whitespace before hashing to catch near-duplicates
  const normalized = str.replace(/\s+/g, ' ').trim();
  return createHash('md5').update(normalized).digest('hex').slice(0, 16);
}

export function close() {
  if (db) { db.close(); db = null; }
}

// ── Preference Signals ────────────────────────────────────────

/**
 * Insert a preference signal. Dedup by agent + subject + context + chunk_id.
 */
export function insertPreferenceSignal({ agent, domain, subject, context, sentiment, rawText, sessionId, chunkId }) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id FROM preference_signals WHERE agent = ? AND subject = ? AND context IS NOT DISTINCT FROM ? AND chunk_id = ?'
  ).get(agent, subject, context, chunkId);
  if (existing) return { id: existing.id, deduped: true };

  const result = db.prepare(`
    INSERT INTO preference_signals (agent, domain, subject, context, sentiment, raw_text, session_id, chunk_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(agent, domain, subject, context, sentiment, rawText, sessionId, chunkId, Date.now());

  return { id: result.lastInsertRowid, deduped: false };
}

/**
 * Aggregate preference signals for a domain. Returns preference profile.
 * GROUP BY subject + context, average sentiment, count distinct sessions.
 */
export function aggregatePreferences(agent, { domain, minSentiment = 0.0, limit = 20 } = {}) {
  const db = getDb();
  let sql = `
    SELECT subject, context, AVG(sentiment) as avg_sentiment,
           COUNT(DISTINCT session_id) as sessions, COUNT(*) as signals,
           GROUP_CONCAT(DISTINCT chunk_id) as chunk_ids
    FROM preference_signals
    WHERE agent = ?
  `;
  const params = [agent];
  if (domain) { sql += ' AND domain = ?'; params.push(domain); }
  sql += ` GROUP BY subject, context HAVING avg_sentiment > ? ORDER BY sessions DESC, avg_sentiment DESC LIMIT ?`;
  params.push(minSentiment, limit);

  return db.prepare(sql).all(...params);
}

/**
 * Search preference signals by subject keywords. Returns matching signals with source chunks.
 */
export function searchPreferences(query, { agent, domain, limit = 20 } = {}) {
  const db = getDb();
  const terms = query.replace(/[?!.,;:'"]/g, '').split(/\s+/).filter(w => w.length > 2);
  if (terms.length === 0) return [];

  const conditions = terms.map(() => '(p.subject LIKE ? OR p.context LIKE ? OR p.domain LIKE ?)');
  const params = [];
  for (const t of terms) {
    params.push(`%${t}%`, `%${t}%`, `%${t}%`);
  }

  let sql = `SELECT p.*, c.content as source_content, c.session_id as source_session
    FROM preference_signals p
    LEFT JOIN chunks c ON c.id = p.chunk_id
    WHERE (${conditions.join(' OR ')})`;
  if (agent) { sql += ' AND p.agent = ?'; params.push(agent); }
  if (domain) { sql += ' AND p.domain = ?'; params.push(domain); }
  sql += ' ORDER BY p.sentiment DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

// ── Facts ─────────────────────────────────────────────────────

/**
 * Insert a fact into the dedicated facts table.
 * Deduplicates by agent + predicate + object.
 */
export function insertFact({ agent, predicate, object, sourceChunkId, sessionId, timestamp }) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id FROM facts WHERE agent = ? AND predicate = ? AND object = ?'
  ).get(agent, predicate, object);
  if (existing) return { id: existing.id, deduped: true };

  const result = db.prepare(`
    INSERT INTO facts (agent, predicate, object, source_chunk_id, session_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(agent, predicate, object, sourceChunkId, sessionId, timestamp);

  return { id: result.lastInsertRowid, deduped: false };
}

/**
 * Search facts by keyword. Returns matching facts with source session IDs.
 */
export function searchFacts(query, { agent, limit = 20 } = {}) {
  const db = getDb();
  const terms = query.replace(/[?!.,;:'"]/g, '').split(/\s+/).filter(w => w.length > 2);
  if (terms.length === 0) return [];

  const conditions = terms.map(() => '(f.predicate LIKE ? OR f.object LIKE ?)');
  const params = [];
  for (const t of terms) {
    params.push(`%${t}%`, `%${t}%`);
  }

  let sql = `SELECT f.*, COUNT(*) OVER (PARTITION BY f.id) as term_hits FROM facts f WHERE (${conditions.join(' OR ')})`;
  if (agent) { sql += ' AND f.agent = ?'; params.push(agent); }
  sql += ' ORDER BY term_hits DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

// ── Session Tracking ──────────────────────────────────────────

export function getSession(sessionId) {
  const db = getDb();
  return db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
}

export function upsertSession({ sessionId, filePath, agent, fileSize, lastByteOffset, messageCount, firstTimestamp, lastTimestamp }) {
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM sessions WHERE session_id = ?').get(sessionId);

  if (existing) {
    db.prepare(`
      UPDATE sessions SET file_size = ?, last_byte_offset = ?, message_count = ?,
        last_timestamp = ?, last_indexed_at = ?
      WHERE id = ?
    `).run(fileSize, lastByteOffset, messageCount, lastTimestamp, now, existing.id);
    return { updated: true, sessionId };
  }

  db.prepare(`
    INSERT INTO sessions (session_id, file_path, agent, file_size, last_byte_offset,
      message_count, first_timestamp, last_timestamp, last_indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, filePath, agent, fileSize, lastByteOffset, messageCount, firstTimestamp, lastTimestamp, now);
  return { created: true, sessionId };
}

export function getRecentSessions(agent, limit = 10) {
  const db = getDb();
  let sql = 'SELECT * FROM sessions';
  const params = [];
  if (agent) {
    sql += ' WHERE agent = ?';
    params.push(agent);
  }
  sql += ' ORDER BY last_timestamp DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function getSessionChunks(sessionId, { limit = 200 } = {}) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM chunks WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?'
  ).all(sessionId, limit);
}

// ── Session Bookmarks ───────────────────────────────────────

/**
 * Create or update a session bookmark.
 */
export function upsertBookmark({ sessionId, agent, directory, projectName, startedAt, endedAt, summary, filesTouched, chunksIndexed, tags }) {
  const db = getDb();
  const duration = (endedAt && startedAt) ? endedAt - startedAt : null;

  // Auto-detect project name from directory if not provided
  const project = projectName || detectProjectName(directory);

  db.prepare(`
    INSERT OR REPLACE INTO session_bookmarks
    (session_id, agent, directory, project_name, started_at, ended_at, duration, summary, files_touched, chunks_indexed, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, agent, directory, project, startedAt, endedAt, duration, summary,
    filesTouched ? JSON.stringify(filesTouched) : null, chunksIndexed || 0,
    tags ? JSON.stringify(tags) : null);

  return { bookmarked: true, sessionId, project };
}

/**
 * Get the last session bookmark for an agent (optionally filtered by project/directory).
 * Returns { current_directory, parallel_work } when directory is provided.
 */
export function getLastSession(agent, { project, directory } = {}) {
  const db = getDb();

  // Get the most recent session (optionally scoped to directory/project)
  let sql = 'SELECT * FROM session_bookmarks WHERE agent = ?';
  const params = [agent];
  if (project) { sql += ' AND project_name = ?'; params.push(project); }
  if (directory) { sql += ' AND directory = ?'; params.push(directory); }
  sql += ' ORDER BY ended_at DESC LIMIT 1';
  const row = db.prepare(sql).get(...params);

  if (!row) return null;

  // Get the last few chunks from that session for context
  const recentChunks = db.prepare(
    'SELECT content, timestamp FROM chunks WHERE session_id = ? AND agent = ? ORDER BY timestamp DESC LIMIT 5'
  ).all(row.session_id, agent);

  const current = {
    ...row,
    files_touched: row.files_touched ? JSON.parse(row.files_touched) : [],
    tags: row.tags ? JSON.parse(row.tags) : [],
    recent_chunks: recentChunks,
  };

  // Find parallel work: other recent sessions across directories
  // Parallel = within 24h of current session, different directory
  const parallelWork = findParallelSessions(db, agent, current);

  return {
    current_directory: current,
    parallel_work: parallelWork,
  };
}

/**
 * Find sessions that overlap with the given session —
 * either within 24h or sharing 3+ tags (same project, different folder).
 */
function findParallelSessions(db, agent, session) {
  const DAY_MS = 86400000;
  const windowStart = (session.ended_at || session.started_at || 0) - DAY_MS;
  const windowEnd = (session.ended_at || Date.now()) + DAY_MS;

  // Get recent sessions in other directories within the time window
  const rows = db.prepare(`
    SELECT * FROM session_bookmarks
    WHERE agent = ? AND directory != ? AND ended_at > ? AND started_at < ?
    ORDER BY ended_at DESC LIMIT 10
  `).all(agent, session.directory || '', windowStart, windowEnd);

  // Also get sessions that share the same project (even outside time window)
  const projectRows = session.project_name ? db.prepare(`
    SELECT * FROM session_bookmarks
    WHERE agent = ? AND project_name = ? AND session_id != ? AND directory != ?
    ORDER BY ended_at DESC LIMIT 5
  `).all(agent, session.project_name, session.session_id, session.directory || '') : [];

  // Merge and deduplicate
  const seen = new Set();
  const all = [];
  for (const r of [...rows, ...projectRows]) {
    if (seen.has(r.session_id)) continue;
    seen.add(r.session_id);

    const tags = r.tags ? JSON.parse(r.tags) : [];
    const sessionTags = session.tags || [];
    const tagOverlap = tags.filter(t => sessionTags.includes(t)).length;

    all.push({
      ...r,
      files_touched: r.files_touched ? JSON.parse(r.files_touched) : [],
      tags,
      tag_overlap: tagOverlap,
      relation: r.project_name === session.project_name ? 'same_project'
        : tagOverlap >= 3 ? 'shared_topics'
        : 'time_overlap',
    });
  }

  // Sort by relevance: same project first, then tag overlap, then recency
  return all.sort((a, b) => {
    if (a.relation === 'same_project' && b.relation !== 'same_project') return -1;
    if (b.relation === 'same_project' && a.relation !== 'same_project') return 1;
    if (a.tag_overlap !== b.tag_overlap) return b.tag_overlap - a.tag_overlap;
    return (b.ended_at || 0) - (a.ended_at || 0);
  });
}

/**
 * Get recent session bookmarks for an agent.
 */
export function getRecentBookmarks(agent, { project, limit = 10 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM session_bookmarks WHERE agent = ?';
  const params = [agent];
  if (project) { sql += ' AND project_name = ?'; params.push(project); }
  sql += ' ORDER BY ended_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params).map(row => ({
    ...row,
    files_touched: row.files_touched ? JSON.parse(row.files_touched) : [],
    tags: row.tags ? JSON.parse(row.tags) : [],
  }));
}

/**
 * Detect project name from a directory path.
 * Checks git remote first, falls back to directory name.
 */
function detectProjectName(directory) {
  if (!directory) return null;

  // Try git remote
  try {
    const { execFileSync } = childProcess;
    const remote = execFileSync('git', ['-C', directory, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (remote) {
      // Extract repo name from URL: github.com/user/repo.git → repo
      const match = remote.match(/\/([^\/]+?)(?:\.git)?$/);
      if (match) return match[1];
    }
  } catch { }

  // Fallback: last meaningful directory name
  const parts = directory.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

// ── Knowledge Graph Relations ───────────────────────────────

/**
 * Upsert a KG relation. Increments weight and session_count on conflict.
 */
export function upsertKgRelation({ sourceType, source, relation, targetType, target, weight = 1.0 }) {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO kg_relations (source_type, source, relation, target_type, target, weight, session_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(source_type, source, relation, target_type, target)
    DO UPDATE SET weight = weight + ?, session_count = session_count + 1, updated_at = ?
  `).run(sourceType, source, relation, targetType, target, weight, now, now, weight, now);
}

/**
 * Query KG relations from a node.
 * @param {string} nodeType - 'topic' | 'directory' | 'project' | 'agent'
 * @param {string} node - the node value
 * @param {object} opts - { relation, targetType, limit }
 */
export function getKgRelations(nodeType, node, { relation, targetType, limit = 50 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM kg_relations WHERE source_type = ? AND source = ?';
  const params = [nodeType, node];
  if (relation) { sql += ' AND relation = ?'; params.push(relation); }
  if (targetType) { sql += ' AND target_type = ?'; params.push(targetType); }
  sql += ' ORDER BY weight DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

/**
 * Query KG relations TO a node (reverse lookup).
 */
export function getKgRelationsTo(nodeType, node, { relation, sourceType, limit = 50 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM kg_relations WHERE target_type = ? AND target = ?';
  const params = [nodeType, node];
  if (relation) { sql += ' AND relation = ?'; params.push(relation); }
  if (sourceType) { sql += ' AND source_type = ?'; params.push(sourceType); }
  sql += ' ORDER BY weight DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

/**
 * Materialize topic co-occurrence from existing tags + sessions into kg_relations.
 * Idempotent — clears existing topic→topic edges and rebuilds.
 */
export function materializeTopicRelations() {
  const db = getDb();
  const now = Date.now();

  // Clear old topic-topic relations
  db.prepare("DELETE FROM kg_relations WHERE source_type = 'topic' AND target_type = 'topic'").run();

  // Build co-occurrence: tags that appear in the same sessions
  const pairs = db.prepare(`
    SELECT t1.tag as source, t2.tag as target,
           COUNT(DISTINCT c1.session_id) as session_count,
           COUNT(*) as co_count
    FROM tags t1
    JOIN chunks c1 ON c1.id = t1.chunk_id
    JOIN chunks c2 ON c2.session_id = c1.session_id AND c2.id != c1.id
    JOIN tags t2 ON t2.chunk_id = c2.id
    WHERE t1.tag < t2.tag AND c1.session_id IS NOT NULL
    GROUP BY t1.tag, t2.tag
    HAVING session_count >= 2
  `).all();

  const insert = db.prepare(`
    INSERT INTO kg_relations (source_type, source, relation, target_type, target, weight, session_count, created_at, updated_at)
    VALUES ('topic', ?, 'related_to', 'topic', ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const p of pairs) {
      insert.run(p.source, p.target, p.session_count, p.session_count, now, now);
    }
  });
  tx();

  return { edges: pairs.length };
}

/**
 * Build directory KG edges from session bookmarks.
 * Creates: directory→project, directory→topic, directory→directory edges.
 */
export function materializeDirectoryRelations() {
  const db = getDb();
  const now = Date.now();

  // Clear old directory edges
  db.prepare("DELETE FROM kg_relations WHERE source_type = 'directory' OR target_type = 'directory'").run();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO kg_relations (source_type, source, relation, target_type, target, weight, session_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    // directory → project edges
    const dirProjects = db.prepare(`
      SELECT directory, project_name, COUNT(*) as session_count
      FROM session_bookmarks
      WHERE directory IS NOT NULL AND project_name IS NOT NULL
      GROUP BY directory, project_name
    `).all();

    for (const dp of dirProjects) {
      insert.run('directory', dp.directory, 'belongs_to', 'project', dp.project_name, dp.session_count, dp.session_count, now, now);
    }

    // directory → topic edges (aggregate tags per directory)
    const bookmarks = db.prepare(`
      SELECT directory, tags FROM session_bookmarks WHERE directory IS NOT NULL AND tags IS NOT NULL
    `).all();

    const dirTopics = new Map(); // dir → { tag → count }
    for (const b of bookmarks) {
      const tags = JSON.parse(b.tags);
      if (!dirTopics.has(b.directory)) dirTopics.set(b.directory, new Map());
      const topicMap = dirTopics.get(b.directory);
      for (const tag of tags) {
        topicMap.set(tag, (topicMap.get(tag) || 0) + 1);
      }
    }

    for (const [dir, topics] of dirTopics) {
      for (const [topic, count] of topics) {
        if (count >= 2) {
          insert.run('directory', dir, 'works_on', 'topic', topic, count, count, now, now);
        }
      }
    }

    // directory → directory edges (same project = related)
    const dirsByProject = new Map();
    for (const dp of dirProjects) {
      if (!dirsByProject.has(dp.project_name)) dirsByProject.set(dp.project_name, []);
      dirsByProject.get(dp.project_name).push(dp.directory);
    }

    for (const [_project, dirs] of dirsByProject) {
      for (let i = 0; i < dirs.length; i++) {
        for (let j = i + 1; j < dirs.length; j++) {
          insert.run('directory', dirs[i], 'related_to', 'directory', dirs[j], 1.0, 1, now, now);
        }
      }
    }
  });
  tx();

  return { materialized: true };
}

// ── Agent Aliases ───────────────────────────────────────────

/**
 * Resolve an agent name through aliases.
 * If the name has an alias, returns the canonical name. Otherwise returns as-is.
 */
export function resolveAgent(name) {
  if (!name) return name;
  const db = getDb();
  const alias = db.prepare('SELECT canonical FROM agent_aliases WHERE alias = ?').get(name.toLowerCase());
  return alias ? alias.canonical : name;
}

/**
 * Create an alias. Also retroactively re-tags all existing chunks and sessions.
 */
export function createAlias(alias, canonical) {
  const db = getDb();
  const lower = alias.toLowerCase();
  const canon = canonical.toLowerCase();

  // Conflict guard: cannot alias a name that has its own personality
  try {
    const personality = db.prepare('SELECT name FROM personalities WHERE name = ?').get(lower);
    if (personality) {
      return { created: false, reason: `"${lower}" is a canonical agent with a personality — cannot alias it` };
    }
  } catch { /* personalities table might not exist yet — no conflict */ }

  // Cannot alias to itself
  if (lower === canon) return { created: false, reason: 'cannot alias to itself' };

  const now = Date.now();
  db.prepare('INSERT OR REPLACE INTO agent_aliases (alias, canonical, created_at) VALUES (?, ?, ?)').run(lower, canon, now);

  // Retroactive re-tag: update all chunks and sessions with agent = alias → canonical
  const chunkChanges = db.prepare('UPDATE chunks SET agent = ? WHERE agent = ?').run(canon, lower).changes;
  const sessionChanges = db.prepare('UPDATE sessions SET agent = ? WHERE agent = ?').run(canon, lower).changes;

  return { created: true, alias: lower, canonical: canon, retagged: { chunks: chunkChanges, sessions: sessionChanges } };
}

/**
 * Remove an alias. Does NOT revert chunks — they stay under the canonical name.
 */
export function removeAlias(alias) {
  const db = getDb();
  const result = db.prepare('DELETE FROM agent_aliases WHERE alias = ?').run(alias.toLowerCase());
  return { removed: result.changes > 0 };
}

/**
 * List all aliases.
 */
export function listAliases() {
  const db = getDb();
  return db.prepare('SELECT alias, canonical, created_at FROM agent_aliases ORDER BY canonical, alias').all();
}

/**
 * Get agent summary — all agents with chunk and session counts.
 */
export function getAgentSummary() {
  const db = getDb();
  const agents = db.prepare(`
    SELECT agent, COUNT(*) as chunks,
      COUNT(DISTINCT session_id) as sessions
    FROM chunks
    GROUP BY agent
    ORDER BY chunks DESC
  `).all();
  return agents;
}

// ── Project State Tracking ──────────────────────────────────
// Tracks project lifecycle: active → shipped/abandoned/blocked
// The supervisor reads this. L1 includes active/shipped summary.
// Completion events close the loop — no more stale "in progress" in memory.

function initProjectsTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      started TEXT,
      last_touched INTEGER,
      completed INTEGER,
      summary TEXT,
      pending TEXT,
      shipped TEXT,
      agent TEXT,
      gitea_repo TEXT,
      metadata TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)`);
}

export function upsertProject({ name, status, summary, pending, shipped, agent, giteaRepo, metadata }) {
  const db = getDb();
  initProjectsTable();
  const now = Date.now();
  
  const existing = db.prepare('SELECT id FROM projects WHERE name = ?').get(name);
  
  if (existing) {
    const sets = [];
    const vals = [];
    if (status) { sets.push('status = ?'); vals.push(status); }
    if (summary) { sets.push('summary = ?'); vals.push(summary); }
    if (pending !== undefined) { sets.push('pending = ?'); vals.push(pending); }
    if (shipped !== undefined) { sets.push('shipped = ?'); vals.push(shipped); }
    if (agent) { sets.push('agent = ?'); vals.push(agent); }
    if (giteaRepo) { sets.push('gitea_repo = ?'); vals.push(giteaRepo); }
    if (metadata) { sets.push('metadata = ?'); vals.push(JSON.stringify(metadata)); }
    sets.push('last_touched = ?'); vals.push(now);
    if (status === 'shipped' || status === 'abandoned') { sets.push('completed = ?'); vals.push(now); }
    vals.push(existing.id);
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return { updated: true, name };
  } else {
    db.prepare(
      'INSERT INTO projects (name, status, started, last_touched, summary, pending, shipped, agent, gitea_repo, metadata) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(name, status || 'active', new Date().toISOString(), now, summary || '', pending || '', shipped || '', agent || '', giteaRepo || '', metadata ? JSON.stringify(metadata) : null);
    return { created: true, name };
  }
}

export function getProjects(status) {
  const db = getDb();
  initProjectsTable();
  if (status) {
    return db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY last_touched DESC').all(status);
  }
  return db.prepare('SELECT * FROM projects ORDER BY last_touched DESC').all();
}

export function getProject(name) {
  const db = getDb();
  initProjectsTable();
  return db.prepare('SELECT * FROM projects WHERE name = ?').get(name);
}

export function shipProject(name, shippedNote) {
  const db = getDb();
  initProjectsTable();
  const now = Date.now();
  db.prepare('UPDATE projects SET status = ?, completed = ?, last_touched = ?, shipped = COALESCE(shipped, ?) WHERE name = ?')
    .run('shipped', now, now, shippedNote || '', name);
  return { shipped: true, name };
}
