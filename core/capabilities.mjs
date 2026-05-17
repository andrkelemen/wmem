/*
  core/capabilities.mjs — CRUD + lookup for the capabilities registry.

  Shape:
    addCapability    : insert/replace (UNIQUE on personality_id+name)
    updateCapability : partial update by (personality_id, name)
    removeCapability : delete by (personality_id, name)
    getCapability    : single row by (personality_id, name)
    listCapabilities : filtered enumeration
    lookupCapabilities : FTS5 match on name + description + tags (v1 match algorithm)
    matchCapabilities : semantic match stub; falls through to lookupCapabilities
                       for v1. Embedding pipeline is a future enhancement.
    verifyCapability : bump last_verified timestamp

  All writes require an explicit personality_id from the caller (the MCP tool layer
  stamps it from WMEM_CALLER / session identity). Spoof-impossible by design.
*/

import { getDb } from './db.mjs';

const TIER_ORDER = { primary: 0, standard: 1, fallback: 2 };

function toJson(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;  // already serialized
  return JSON.stringify(v);
}

function fromJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    requires: fromJson(row.requires),
    metadata: fromJson(row.metadata),
  };
}

/*
  addCapability({ agentId, name, category, description?, location?,
                  version?, requires?, tier?, status?, metadata? })
  Returns { id, added } where `added` is true on insert, false on replace.
*/
export function addCapability({
  agentId, name, category,
  description = null, location = null, version = null,
  requires = null, tier = 'standard', status = 'active',
  metadata = null,
}) {
  if (!agentId) throw new Error('agentId required');
  if (!name)    throw new Error('name required');
  if (!category) throw new Error('category required');

  const db = getDb();
  const existing = db.prepare('SELECT id FROM capabilities WHERE personality_id = ? AND name = ?').get(agentId, name);
  if (existing) {
    db.prepare(`
      UPDATE capabilities
         SET category = ?, description = ?, location = ?, version = ?,
             requires = ?, tier = ?, status = ?, metadata = ?
       WHERE id = ?
    `).run(category, description, location, version, toJson(requires), tier, status, toJson(metadata), existing.id);
    return { id: existing.id, added: false };
  }
  const result = db.prepare(`
    INSERT INTO capabilities
      (personality_id, name, category, description, location, version, requires, tier, status, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(agentId, name, category, description, location, version, toJson(requires), tier, status, toJson(metadata));
  return { id: result.lastInsertRowid, added: true };
}

/*
  updateCapability({ agentId, name, fields })
  `fields` is a partial object — only supplied keys are written. Returns
  { updated: true } on change, { updated: false } if row missing.
*/
export function updateCapability({ agentId, name, fields }) {
  if (!agentId || !name || !fields) throw new Error('agentId, name, fields required');
  const allowed = ['category', 'description', 'location', 'version', 'requires', 'tier', 'status', 'metadata'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      vals.push(k === 'requires' || k === 'metadata' ? toJson(fields[k]) : fields[k]);
    }
  }
  if (sets.length === 0) return { updated: false, reason: 'no fields' };
  vals.push(agentId, name);
  const db = getDb();
  const result = db.prepare(`UPDATE capabilities SET ${sets.join(', ')} WHERE personality_id = ? AND name = ?`).run(...vals);
  return { updated: result.changes > 0 };
}

/*
  removeCapability({ agentId, name })
  Returns { removed: true|false }.
*/
export function removeCapability({ agentId, name }) {
  if (!agentId || !name) throw new Error('agentId and name required');
  const db = getDb();
  const result = db.prepare('DELETE FROM capabilities WHERE personality_id = ? AND name = ?').run(agentId, name);
  return { removed: result.changes > 0 };
}

/*
  getCapability({ agentId, name }) → row or null.
*/
export function getCapability({ agentId, name }) {
  if (!agentId || !name) throw new Error('agentId and name required');
  const db = getDb();
  const row = db.prepare('SELECT * FROM capabilities WHERE personality_id = ? AND name = ?').get(agentId, name);
  return hydrate(row);
}

/*
  listCapabilities({ agent?, category?, status?, limit? }) → rows[]
  All filters optional. Default limit 100. Ordered by (agent, name).
*/
export function listCapabilities({ agent = null, category = null, status = null, limit = 100 } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (agent)    { where.push('personality_id = ?'); params.push(agent); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (status)   { where.push('status = ?');   params.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);
  const rows = db.prepare(`
    SELECT * FROM capabilities
     ${whereSql}
     ORDER BY personality_id, name
     LIMIT ?
  `).all(...params);
  return rows.map(hydrate);
}

/*
  lookupCapabilities({ query, category?, minTier?, limit? }) → ranked rows[]

  FTS5 keyword search across name, description, metadata.tags.
  Rank boost: tier weight (primary=1.0, standard=0.8, fallback=0.6).
  `minTier` filters results to that tier or higher.
*/
export function lookupCapabilities({ query, category = null, minTier = null, limit = 20 }) {
  if (!query || !query.trim()) return [];
  const db = getDb();

  // Pass query through to FTS5 as-is. FTS5 default is implicit-AND across
  // tokens — each word must appear somewhere in the indexed columns, any
  // order. That matches real user intent for keyword search. Wrapping in
  // quotes (earlier version) forced phrase-mode which was too strict —
  // review caught that realistic queries returned zero.
  // Callers who want phrase match pass `"their phrase"` themselves.
  // Callers who want operator behavior pass bare FTS5 syntax (AND/OR/NOT).
  const ftsQuery = query.trim();

  const where = [`capabilities_fts MATCH ?`];
  const params = [ftsQuery];
  if (category) { where.push('c.category = ?'); params.push(category); }
  if (minTier) {
    const allowed = Object.keys(TIER_ORDER).filter((t) => TIER_ORDER[t] <= TIER_ORDER[minTier]);
    where.push(`c.tier IN (${allowed.map(() => '?').join(',')})`);
    params.push(...allowed);
  }
  params.push(limit);

  const rows = db.prepare(`
    SELECT c.*, bm25(capabilities_fts) AS rank
      FROM capabilities_fts
      JOIN capabilities c ON c.id = capabilities_fts.rowid
     WHERE ${where.join(' AND ')}
       AND c.status = 'active'
     -- bm25 returns a NEGATIVE score where lower = more relevant. Multiplying
     -- by a SMALLER tier weight makes the product MORE negative → ranks higher.
     -- So 0.6 (primary) beats 0.8 (standard) beats 1.0 (fallback).
     ORDER BY (bm25(capabilities_fts)
              * CASE c.tier
                  WHEN 'primary'  THEN 0.6
                  WHEN 'standard' THEN 0.8
                  WHEN 'fallback' THEN 1.0
                  ELSE 1.0
                END)
     LIMIT ?
  `).all(...params);
  return rows.map((r) => {
    const h = hydrate(r);
    h.match_score = r.rank;
    return h;
  });
}

/*
  matchCapabilities({ workload, limit? }) → ranked rows[]

  Semantic match. v1 keyword strategy: tokenize the workload narrative,
  strip English stopwords, join surviving terms with FTS5 OR so ANY
  matching term surfaces the capability. Tier weighting in bm25 ordering
  still ranks primary above standard above fallback.

  When an embedding pipeline is added later, the public surface stays identical —
  internals swap to ANN over capability description embeddings.
*/
const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','of','in','on',
  'at','to','for','with','and','or','but','not','as','from','by','this',
  'that','these','those','i','me','my','we','us','our','you','your','it',
  'its','need','want','do','does','have','has','had','can','could','should',
  'would','will','shall','may','might','must','about','into','over','under',
]);

export function matchCapabilities({ workload, limit = 10 }) {
  if (!workload) return [];
  const tokens = String(workload).toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) || [];
  const terms = [...new Set(tokens.filter((t) => t.length > 2 && !STOPWORDS.has(t)))];
  if (terms.length === 0) return [];
  // Quote each token to neutralize FTS5 syntax, join with OR for union match.
  const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  return lookupCapabilities({ query: ftsQuery, limit });
}

/*
  verifyCapability({ agentId, name }) → { verified: true, verified_at } on success
                                        { verified: false, error: 'not_found' } on miss
  Self-attestation; the observer writes its own verification. Cross-agent
  probe is a separate tool (future PR).

  Matches `getCapability`'s don't-throw-on-miss pattern — returns-not-throws discipline
  review flagged the inconsistency. Not-found is normal flow, not exceptional.
*/
export function verifyCapability({ agentId, name }) {
  if (!agentId || !name) throw new Error('agentId and name required');
  const db = getDb();
  const now = Date.now();
  const result = db.prepare(`
    UPDATE capabilities SET last_verified = ? WHERE personality_id = ? AND name = ?
  `).run(now, agentId, name);
  if (result.changes === 0) {
    return { verified: false, error: 'not_found' };
  }
  return { verified: true, verified_at: now };
}
