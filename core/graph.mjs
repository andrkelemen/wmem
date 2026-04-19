/**
 * graph.mjs — Lightweight knowledge graph via co-occurrence
 *
 * Relationships emerge from data, not manual linking:
 * - Chunks that share a session are related (co-occurrence)
 * - Chunks that share tags are strongly related (topical)
 * - Tags that appear together form topic clusters
 *
 * No external graph database. Pure SQLite queries over existing tables.
 * "What relates to X?" answered in <50ms.
 */

import { getDb, getKgRelations, getKgRelationsTo } from './db.mjs';

/**
 * Find chunks related to a query by tag co-occurrence.
 * "What relates to authentication?" → finds everything tagged 'auth'
 * plus everything that appeared in the same sessions as auth-tagged chunks.
 *
 * @param {string} topic - tag name or search term
 * @param {object} opts - { agent, limit, depth }
 *   depth 1: direct tag matches
 *   depth 2: + chunks from same sessions (co-occurrence)
 * @returns {Array} related chunks with relationship metadata
 */
export function findRelated(topic, { agent, limit = 20, depth = 2 } = {}) {
  const db = getDb();
  const results = new Map(); // chunk_id → { chunk, relation, strength }

  // Depth 1: direct tag matches
  let tagSql = `
    SELECT c.*, t.tag, t.confidence, 'direct_tag' as relation
    FROM tags t JOIN chunks c ON c.id = t.chunk_id
    WHERE t.tag = ?
  `;
  const tagParams = [topic.toLowerCase()];
  if (agent) { tagSql += " AND (c.agent = ? OR c.agent = '_shared')"; tagParams.push(agent); }
  tagSql += ' ORDER BY c.timestamp DESC LIMIT ?';
  tagParams.push(limit);

  const directMatches = db.prepare(tagSql).all(...tagParams);
  for (const m of directMatches) {
    results.set(m.id, { ...m, relation: 'direct_tag', strength: m.confidence || 1.0 });
  }

  if (depth < 2 || directMatches.length === 0) {
    return Array.from(results.values()).slice(0, limit);
  }

  // Depth 2: co-occurrence — find chunks from the same sessions
  const sessionIds = [...new Set(directMatches.map(m => m.session_id).filter(Boolean))];
  if (sessionIds.length > 0) {
    const placeholders = sessionIds.map(() => '?').join(',');
    let coSql = `
      SELECT c.*, 'co_session' as relation
      FROM chunks c
      WHERE c.session_id IN (${placeholders})
        AND c.id NOT IN (${[...results.keys()].map(() => '?').join(',') || '0'})
    `;
    const coParams = [...sessionIds, ...results.keys()];
    if (agent) { coSql += " AND (c.agent = ? OR c.agent = '_shared')"; coParams.push(agent); }
    coSql += ' ORDER BY c.timestamp DESC LIMIT ?';
    coParams.push(limit);

    const coMatches = db.prepare(coSql).all(...coParams);
    for (const m of coMatches) {
      results.set(m.id, { ...m, relation: 'co_session', strength: 0.5 });
    }
  }

  return Array.from(results.values())
    .sort((a, b) => b.strength - a.strength)
    .slice(0, limit);
}

/**
 * Find topics related to a given topic by co-occurrence in sessions.
 * "What topics appear alongside 'auth'?"
 *
 * @param {string} topic - tag name
 * @param {object} opts - { agent, limit }
 * @returns {Array<{tag, count, sessions}>} related topics ranked by frequency
 */
export function relatedTopics(topic, { agent, limit = 15 } = {}) {
  const db = getDb();

  // Find sessions where this topic appears
  let sessionSql = `
    SELECT DISTINCT c.session_id
    FROM tags t JOIN chunks c ON c.id = t.chunk_id
    WHERE t.tag = ?
  `;
  const sessionParams = [topic.toLowerCase()];
  if (agent) { sessionSql += " AND (c.agent = ? OR c.agent = '_shared')"; sessionParams.push(agent); }

  const sessions = db.prepare(sessionSql).all(...sessionParams).map(r => r.session_id).filter(Boolean);
  if (sessions.length === 0) return [];

  // Find other tags in those sessions
  const placeholders = sessions.map(() => '?').join(',');
  const relatedSql = `
    SELECT t.tag, COUNT(DISTINCT c.session_id) as sessions, COUNT(*) as count
    FROM tags t JOIN chunks c ON c.id = t.chunk_id
    WHERE c.session_id IN (${placeholders})
      AND t.tag != ?
    GROUP BY t.tag
    ORDER BY sessions DESC, count DESC
    LIMIT ?
  `;

  return db.prepare(relatedSql).all(...sessions, topic.toLowerCase(), limit);
}

/**
 * Build a topic graph — all tag-to-tag relationships by co-occurrence.
 * Returns edges: [{source, target, weight}] where weight = shared session count.
 *
 * @param {object} opts - { agent, minWeight }
 * @returns {{ nodes: [{tag, count}], edges: [{source, target, weight}] }}
 */
export function buildTopicGraph({ agent, minWeight = 2 } = {}) {
  const db = getDb();

  // Get all tag pairs that co-occur in sessions
  let pairSql = `
    SELECT t1.tag as source, t2.tag as target,
           COUNT(DISTINCT c1.session_id) as weight
    FROM tags t1
    JOIN chunks c1 ON c1.id = t1.chunk_id
    JOIN chunks c2 ON c2.session_id = c1.session_id AND c2.id != c1.id
    JOIN tags t2 ON t2.chunk_id = c2.id
    WHERE t1.tag < t2.tag
  `;
  const params = [];
  if (agent) {
    pairSql += " AND (c1.agent = ? OR c1.agent = '_shared')";
    params.push(agent);
  }
  pairSql += ' GROUP BY t1.tag, t2.tag HAVING weight >= ? ORDER BY weight DESC';
  params.push(minWeight);

  const edges = db.prepare(pairSql).all(...params);

  // Get all nodes with counts
  let nodeSql = 'SELECT tag, COUNT(*) as count FROM tags';
  const nodeParams = [];
  if (agent) {
    nodeSql += ` WHERE chunk_id IN (SELECT id FROM chunks WHERE agent = ? OR agent = '_shared')`;
    nodeParams.push(agent);
  }
  nodeSql += ' GROUP BY tag ORDER BY count DESC';

  const nodes = db.prepare(nodeSql).all(...nodeParams);

  return { nodes, edges };
}

/**
 * Get the relationship path between two topics.
 * "How does 'auth' relate to 'deployment'?"
 * Returns shared sessions and chunks where both topics appear.
 *
 * @param {string} topicA
 * @param {string} topicB
 * @param {object} opts - { agent, limit }
 * @returns {{ shared_sessions, connecting_chunks, strength }}
 */
export function topicPath(topicA, topicB, { agent, limit = 10 } = {}) {
  const db = getDb();

  // Find sessions where both topics appear
  let sql = `
    SELECT DISTINCT c1.session_id,
           MIN(c1.timestamp) as first_ts,
           MAX(c2.timestamp) as last_ts
    FROM tags t1 JOIN chunks c1 ON c1.id = t1.chunk_id
    JOIN tags t2 JOIN chunks c2 ON c2.id = t2.chunk_id
    WHERE t1.tag = ? AND t2.tag = ?
      AND c1.session_id = c2.session_id
      AND c1.session_id IS NOT NULL
  `;
  const params = [topicA.toLowerCase(), topicB.toLowerCase()];
  if (agent) {
    sql += " AND (c1.agent = ? OR c1.agent = '_shared')";
    params.push(agent);
  }
  sql += ' GROUP BY c1.session_id ORDER BY first_ts DESC LIMIT ?';
  params.push(limit);

  const sharedSessions = db.prepare(sql).all(...params);

  // Get connecting chunks (tagged with either topic) from shared sessions
  const sessionIds = sharedSessions.map(s => s.session_id);
  let connectingChunks = [];
  if (sessionIds.length > 0) {
    const ph = sessionIds.map(() => '?').join(',');
    connectingChunks = db.prepare(`
      SELECT DISTINCT c.*, t.tag
      FROM chunks c JOIN tags t ON t.chunk_id = c.id
      WHERE c.session_id IN (${ph})
        AND (t.tag = ? OR t.tag = ?)
      ORDER BY c.timestamp ASC
      LIMIT ?
    `).all(...sessionIds, topicA.toLowerCase(), topicB.toLowerCase(), limit * 2);
  }

  return {
    topicA,
    topicB,
    sharedSessions: sharedSessions.length,
    strength: sharedSessions.length > 5 ? 'strong' : sharedSessions.length > 1 ? 'moderate' : sharedSessions.length === 1 ? 'weak' : 'none',
    sessions: sharedSessions,
    connectingChunks,
  };
}

/**
 * Find related directories for a given directory via the KG.
 * Traverses directory→project→directory and directory→directory edges.
 */
export function relatedDirectories(directory, { limit = 10 } = {}) {
  // Direct directory→directory edges
  const direct = getKgRelations('directory', directory, { relation: 'related_to', targetType: 'directory', limit });

  // Via project: directory→project, then project←directory
  const projects = getKgRelations('directory', directory, { relation: 'belongs_to', targetType: 'project', limit: 5 });
  const viaProject = [];
  for (const p of projects) {
    const siblings = getKgRelationsTo('project', p.target, { relation: 'belongs_to', sourceType: 'directory', limit: 10 });
    for (const s of siblings) {
      if (s.source !== directory) {
        viaProject.push({ ...s, via_project: p.target });
      }
    }
  }

  // Merge and deduplicate
  const seen = new Set();
  const results = [];
  for (const d of [...direct, ...viaProject]) {
    const dir = d.target || d.source;
    if (seen.has(dir)) continue;
    seen.add(dir);
    results.push({
      directory: dir,
      relation: d.relation,
      weight: d.weight,
      via_project: d.via_project || null,
    });
  }

  return results.slice(0, limit);
}

/**
 * Get topics worked on in a directory via the KG.
 */
export function directoryTopics(directory, { limit = 20 } = {}) {
  return getKgRelations('directory', directory, { relation: 'works_on', targetType: 'topic', limit });
}

/**
 * Get directories that work on a given topic.
 */
export function topicDirectories(topic, { limit = 10 } = {}) {
  return getKgRelationsTo('topic', topic, { relation: 'works_on', sourceType: 'directory', limit });
}
