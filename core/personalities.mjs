/**
 * personalities.mjs — the single source for personality identity + memory.
 *
 * Merges the pre-rename agents.mjs (preferences, facts, review queue) and
 * personality.mjs (CRUD, files, L1 build, switches) into one module.
 *
 * Schema lives in migrations/0001 + 0006_personality_rename.sql. This file
 * never CREATE TABLEs — the migration runner is authoritative. Old callers
 * importing agent_* names resolve via the legacy aliases at the bottom.
 */

import { getDb } from './db.mjs';

// ───────────────────────────────────────────────────────────
// personalities CRUD
// ───────────────────────────────────────────────────────────

export function listPersonalities() {
  return getDb().prepare('SELECT * FROM personalities ORDER BY id').all().map(deserialize);
}

export function getPersonality(id) {
  const row = getDb().prepare('SELECT * FROM personalities WHERE id = ?').get(id);
  return row ? deserialize(row) : null;
}

export function getPersonalityByName(name) {
  const row = getDb().prepare('SELECT * FROM personalities WHERE name = ?').get(name);
  return row ? deserialize(row) : null;
}

/**
 * Insert or update a personality. Upsert by id.
 * The id is the stable handle (e.g. 'alpha'); name is the display handle.
 * Behavior columns (voice, capabilities, etc.) are optional — omit and
 * they stay as whatever the row already has.
 */
export function upsertPersonality({
  id, name, role = null, metadata = null,
  displayName, description, systemPrompt, voice,
  capabilities, restrictions, born, avatar,
  enabled, sfw,
  heart, color, cosmology,
}) {
  const db = getDb();
  const meta = metadata && typeof metadata === 'object' ? JSON.stringify(metadata) : metadata;
  const caps = capabilities === undefined ? undefined
    : (Array.isArray(capabilities) ? JSON.stringify(capabilities) : capabilities);
  const rest = restrictions === undefined ? undefined
    : (Array.isArray(restrictions) ? JSON.stringify(restrictions) : restrictions);
  const now = Date.now();

  const existing = db.prepare('SELECT id FROM personalities WHERE id = ?').get(id);
  if (existing) {
    const fields = ['name = ?', 'updated_at = ?'];
    const params = [name, now];
    const set = (col, val) => { if (val !== undefined) { fields.push(`${col} = ?`); params.push(val); } };
    set('role', role);
    set('metadata', meta);
    set('display_name', displayName);
    set('description', description);
    set('system_prompt', systemPrompt);
    set('voice', voice);
    set('capabilities', caps);
    set('restrictions', rest);
    set('born', born);
    set('avatar', avatar);
    set('enabled', enabled === undefined ? undefined : (enabled ? 1 : 0));
    set('sfw', sfw === undefined ? undefined : (sfw ? 1 : 0));
    set('heart', heart);
    set('color', color);
    set('cosmology', cosmology);
    params.push(id);
    db.prepare(`UPDATE personalities SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return { id, updated: true };
  }

  db.prepare(`
    INSERT INTO personalities (
      id, name, role, metadata, heart, color, cosmology,
      display_name, description, system_prompt, voice,
      capabilities, restrictions, born, avatar,
      enabled, sfw, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name, role, meta, heart ?? null, color ?? null, cosmology ?? null,
    displayName ?? name, description ?? null, systemPrompt ?? null, voice ?? null,
    caps ?? null, rest ?? null, born ?? null, avatar ?? null,
    enabled === false ? 0 : 1, sfw === false ? 0 : 1, now, now,
  );
  return { id, created: true };
}

export function deletePersonality(id) {
  const res = getDb().prepare('DELETE FROM personalities WHERE id = ?').run(id);
  return { deleted: res.changes > 0, id };
}

// ───────────────────────────────────────────────────────────
// switches: enabled / sfw
// ───────────────────────────────────────────────────────────

export function setPersonalityEnabled(id, enabled) {
  const db = getDb();
  const exists = db.prepare('SELECT id FROM personalities WHERE id = ?').get(id);
  if (!exists) return { updated: false, reason: 'personality not found' };
  db.prepare('UPDATE personalities SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, Date.now(), id);
  return { updated: true, id, enabled: !!enabled };
}

export function setPersonalitySfw(id, sfw) {
  const db = getDb();
  const exists = db.prepare('SELECT id FROM personalities WHERE id = ?').get(id);
  if (!exists) return { updated: false, reason: 'personality not found' };
  db.prepare('UPDATE personalities SET sfw = ?, updated_at = ? WHERE id = ?')
    .run(sfw ? 1 : 0, Date.now(), id);
  return { updated: true, id, sfw: !!sfw };
}

// ───────────────────────────────────────────────────────────
// active personality — flips `personalities.active = 1` atomically and
// audits the transition. Distinct from session-identity.setCurrentCaller:
// that tracks who THIS process is running as; this tracks who the system globally
// considers online. The panel (switcher v0.2) drives this; MCP tools keep
// driving session-identity.
// ───────────────────────────────────────────────────────────

export function setActivePersonality({ id, caller = null, reason = null }) {
  const db = getDb();
  const target = db.prepare('SELECT id FROM personalities WHERE id = ?').get(id);
  if (!target) throw new Error(`unknown personality: ${id}`);
  const prior = db.prepare('SELECT id FROM personalities WHERE active = 1').get();
  const from = prior ? prior.id : null;
  if (from === id) return { changed: false, from, to: id, audit_id: null };

  const tx = db.transaction(() => {
    db.prepare('UPDATE personalities SET active = 0, updated_at = ? WHERE active = 1')
      .run(Date.now());
    db.prepare('UPDATE personalities SET active = 1, updated_at = ? WHERE id = ?')
      .run(Date.now(), id);
    const audit = db.prepare(
      'INSERT INTO personality_switch_audit (from_personality, to_personality, caller, reason) VALUES (?, ?, ?, ?)',
    ).run(from, id, caller, reason);
    return audit.lastInsertRowid;
  });
  const audit_id = tx();
  return { changed: true, from, to: id, audit_id };
}

export function listSwitchAudit({ limit = 20 } = {}) {
  return getDb().prepare(
    `SELECT id, from_personality, to_personality, caller, reason, ts
     FROM personality_switch_audit
     ORDER BY ts DESC, id DESC
     LIMIT ?`,
  ).all(limit);
}

// ───────────────────────────────────────────────────────────
// personality_files — named documents (identity.md, preferences.md, …)
// ───────────────────────────────────────────────────────────

export function setPersonalityFile(personality, filename, content, alwaysLoad = false) {
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare('SELECT id FROM personality_files WHERE personality = ? AND filename = ?').get(personality, filename);
  if (existing) {
    db.prepare('UPDATE personality_files SET content = ?, always_load = ?, updated_at = ? WHERE id = ?')
      .run(content, alwaysLoad ? 1 : 0, now, existing.id);
    return { updated: true, filename };
  }
  db.prepare('INSERT INTO personality_files (personality, filename, content, always_load, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(personality, filename, content, alwaysLoad ? 1 : 0, now);
  return { created: true, filename };
}

export function getPersonalityFile(personality, filename) {
  return getDb().prepare('SELECT * FROM personality_files WHERE personality = ? AND filename = ?').get(personality, filename);
}

export function listPersonalityFiles(personality) {
  return getDb().prepare(
    'SELECT filename, always_load, updated_at, LENGTH(content) as size FROM personality_files WHERE personality = ? ORDER BY filename'
  ).all(personality);
}

export function deletePersonalityFile(personality, filename) {
  const res = getDb().prepare('DELETE FROM personality_files WHERE personality = ? AND filename = ?').run(personality, filename);
  return { deleted: res.changes > 0 };
}

export function getAlwaysLoadFiles(personality) {
  return getDb().prepare('SELECT filename, content FROM personality_files WHERE personality = ? AND always_load = 1 ORDER BY filename').all(personality);
}

// ───────────────────────────────────────────────────────────
// personality_core — slow-drift identity rows (locked by default)
// ───────────────────────────────────────────────────────────

const VALID_CORE_CATEGORIES = new Set(['identity', 'origin', 'purpose', 'relation']);
const CORE_ORDER = { identity: 0, origin: 1, purpose: 2, relation: 3 };

export function addCore({ personalityId, category, key, content, locked = true, promotedFromTraitId = null }) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM personalities WHERE id = ?').get(personalityId)) {
    throw new Error(`unknown personality: ${personalityId}`);
  }
  if (!VALID_CORE_CATEGORIES.has(category)) {
    throw new Error(`invalid core category: ${category} (must be one of ${[...VALID_CORE_CATEGORIES].join(' | ')})`);
  }
  const now = Date.now();
  const res = db.prepare(`
    INSERT INTO personality_core
      (personality_id, category, key, content, locked, promoted_from_trait_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(personalityId, category, key, content, locked ? 1 : 0, promotedFromTraitId, now, now);
  return { id: Number(res.lastInsertRowid), added: true };
}

export function updateCore({ personalityId, category, key, content, locked, bumpVersion = true }) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id, version FROM personality_core WHERE personality_id = ? AND category = ? AND key = ?'
  ).get(personalityId, category, key);
  if (!existing) return { updated: false, reason: 'not found' };
  const fields = ['updated_at = ?'];
  const params = [Date.now()];
  if (content !== undefined) { fields.push('content = ?'); params.push(content); }
  if (locked !== undefined) { fields.push('locked = ?'); params.push(locked ? 1 : 0); }
  if (bumpVersion && content !== undefined) { fields.push('version = ?'); params.push(existing.version + 1); }
  params.push(existing.id);
  db.prepare(`UPDATE personality_core SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return { updated: true, id: existing.id, version: (bumpVersion && content !== undefined) ? existing.version + 1 : existing.version };
}

export function getCore({ personalityId, category, key }) {
  return getDb().prepare(
    'SELECT * FROM personality_core WHERE personality_id = ? AND category = ? AND key = ?'
  ).get(personalityId, category, key) || null;
}

export function listCore({ personalityId, category } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (personalityId) { where.push('personality_id = ?'); params.push(personalityId); }
  if (category) { where.push('category = ?'); params.push(category); }
  let sql = 'SELECT * FROM personality_core';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY category, key';
  return db.prepare(sql).all(...params);
}

export function deleteCore({ personalityId, category, key }) {
  const res = getDb().prepare(
    'DELETE FROM personality_core WHERE personality_id = ? AND category = ? AND key = ?'
  ).run(personalityId, category, key);
  return { deleted: res.changes > 0 };
}

/**
 * Operator-gated (enforced at the MCP tool layer via WMEM_ADMIN).
 * Copies a trait row's content into personality_core under the given category+key.
 * If the target already exists, bumps its version and re-points promoted_from_trait_id.
 */
export function promoteTraitToCore({ traitId, category, key, content = undefined }) {
  const db = getDb();
  const trait = db.prepare('SELECT * FROM personality_traits WHERE id = ?').get(traitId);
  if (!trait) throw new Error(`unknown trait_id: ${traitId}`);
  if (!VALID_CORE_CATEGORIES.has(category)) {
    throw new Error(`invalid core category: ${category}`);
  }
  const finalContent = content ?? trait.content;
  const now = Date.now();
  const existing = db.prepare(
    'SELECT id, version FROM personality_core WHERE personality_id = ? AND category = ? AND key = ?'
  ).get(trait.personality_id, category, key);
  if (existing) {
    db.prepare(
      'UPDATE personality_core SET content = ?, version = ?, promoted_from_trait_id = ?, updated_at = ? WHERE id = ?'
    ).run(finalContent, existing.version + 1, traitId, now, existing.id);
    return { promoted: true, id: existing.id, updated: true, version: existing.version + 1 };
  }
  const res = db.prepare(`
    INSERT INTO personality_core
      (personality_id, category, key, content, locked, promoted_from_trait_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `).run(trait.personality_id, category, key, finalContent, traitId, now, now);
  return { promoted: true, id: Number(res.lastInsertRowid), created: true, version: 1 };
}

// ───────────────────────────────────────────────────────────
// personality_traits — moderate-drift, amendable rows
// ───────────────────────────────────────────────────────────

const VALID_TRAIT_CATEGORIES = new Set([
  'trait', 'voice-sample', 'rule', 'memory-anchor', 'capability', 'restriction', 'preference',
]);
const TRAIT_ORDER = {
  rule: 0, 'voice-sample': 1, 'memory-anchor': 2, capability: 3, restriction: 4, trait: 5, preference: 6,
};

export function addTrait({
  personalityId, category, key, content,
  priority = 50, enabled = true, confidence = 0.5,
  source = 'manual', sourceChunkId = null,
}) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM personalities WHERE id = ?').get(personalityId)) {
    throw new Error(`unknown personality: ${personalityId}`);
  }
  if (!VALID_TRAIT_CATEGORIES.has(category)) {
    throw new Error(`invalid trait category: ${category} (must be one of ${[...VALID_TRAIT_CATEGORIES].join(' | ')})`);
  }
  const now = Date.now();
  const res = db.prepare(`
    INSERT INTO personality_traits
      (personality_id, category, key, content, priority, enabled, confidence, source, source_chunk_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    personalityId, category, key, content,
    priority, enabled ? 1 : 0, confidence,
    source, sourceChunkId, now, now,
  );
  return { id: Number(res.lastInsertRowid), added: true };
}

export function updateTrait({ personalityId, category, key, content, priority, enabled, confidence }) {
  const db = getDb();
  const existing = db.prepare(
    'SELECT id FROM personality_traits WHERE personality_id = ? AND category = ? AND key = ?'
  ).get(personalityId, category, key);
  if (!existing) return { updated: false, reason: 'not found' };
  const fields = ['updated_at = ?'];
  const params = [Date.now()];
  if (content !== undefined) { fields.push('content = ?'); params.push(content); }
  if (priority !== undefined) { fields.push('priority = ?'); params.push(priority); }
  if (enabled !== undefined) { fields.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (confidence !== undefined) { fields.push('confidence = ?'); params.push(confidence); }
  params.push(existing.id);
  db.prepare(`UPDATE personality_traits SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return { updated: true, id: existing.id };
}

export function getTrait({ personalityId, category, key }) {
  return getDb().prepare(
    'SELECT * FROM personality_traits WHERE personality_id = ? AND category = ? AND key = ?'
  ).get(personalityId, category, key) || null;
}

export function listTraits({ personalityId, category, enabledOnly = false } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (personalityId) { where.push('personality_id = ?'); params.push(personalityId); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (enabledOnly) where.push('enabled = 1');
  let sql = 'SELECT * FROM personality_traits';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY priority DESC, category, key';
  return db.prepare(sql).all(...params);
}

export function enableTrait({ personalityId, category, key }) {
  const res = getDb().prepare(
    'UPDATE personality_traits SET enabled = 1, updated_at = ? WHERE personality_id = ? AND category = ? AND key = ?'
  ).run(Date.now(), personalityId, category, key);
  return { enabled: res.changes > 0 };
}

export function disableTrait({ personalityId, category, key }) {
  const res = getDb().prepare(
    'UPDATE personality_traits SET enabled = 0, updated_at = ? WHERE personality_id = ? AND category = ? AND key = ?'
  ).run(Date.now(), personalityId, category, key);
  return { disabled: res.changes > 0 };
}

export function deleteTrait({ personalityId, category, key }) {
  const res = getDb().prepare(
    'DELETE FROM personality_traits WHERE personality_id = ? AND category = ? AND key = ?'
  ).run(personalityId, category, key);
  return { deleted: res.changes > 0 };
}

// ───────────────────────────────────────────────────────────
// L1 build — personality's hot memory block
// ───────────────────────────────────────────────────────────

/**
 * enabled is the sole gate. sfw is a tag (metadata only) — downstream
 * surfaces (UI, routing, filters) may read it; L1 load is not conditional.
 *
 * Render order (2026-04-19, core+traits split):
 *   1. systemPrompt (legacy column — treated as default identity)
 *   2. personality_core rows (slow-drift), ordered identity → origin → purpose → relation
 *   3. voice column + voice-sample traits
 *   4. personality_traits rows (enabled, priority DESC within category)
 *   5. always-load personality_files (long-form fallback)
 *   6. capabilities / restrictions columns (legacy)
 */
export function buildPersonalityL1(personality) {
  if (!personality) return null;
  if (personality.enabled === false) return null;

  const sections = [];
  if (personality.systemPrompt) {
    sections.push(`PERSONALITY: ${personality.displayName || personality.name}\n${personality.systemPrompt}`);
  }

  const coreRows = listCore({ personalityId: personality.id });
  coreRows.sort((a, b) => (CORE_ORDER[a.category] ?? 99) - (CORE_ORDER[b.category] ?? 99));
  for (const r of coreRows) {
    sections.push(`[CORE ${r.category.toUpperCase()}/${r.key}]\n${r.content}`);
  }

  if (personality.voice) {
    sections.push(`VOICE: ${personality.voice}`);
  }

  const traits = listTraits({ personalityId: personality.id, enabledOnly: true });
  traits.sort((a, b) => {
    const ao = TRAIT_ORDER[a.category] ?? 99;
    const bo = TRAIT_ORDER[b.category] ?? 99;
    if (ao !== bo) return ao - bo;
    return b.priority - a.priority;
  });
  for (const t of traits) {
    sections.push(`[TRAIT ${t.category.toUpperCase()}/${t.key}]\n${t.content}`);
  }

  const files = getAlwaysLoadFiles(personality.id);
  for (const f of files) {
    sections.push(`[${f.filename}]\n${f.content}`);
  }

  if (personality.capabilities && personality.capabilities.length > 0) {
    sections.push(`PERSONALITY CAPABILITIES:\n${personality.capabilities.map(c => `  - ${c}`).join('\n')}`);
  }
  if (personality.restrictions && personality.restrictions.length > 0) {
    sections.push(`RESTRICTIONS:\n${personality.restrictions.map(r => `  - ${r}`).join('\n')}`);
  }
  return sections.join('\n\n');
}

// ───────────────────────────────────────────────────────────
// preferences (tier 2)
// ───────────────────────────────────────────────────────────

export function writePreference({
  personalityId, key, value = null, signalStrength = 0, signalType = 'neutral',
  sourceChunkId = null, metadata = null, relations = [], writtenBy = null,
}) {
  // wmem signal_strength gate: signal_strength bound check. Range [-1, 1] covers neutral=0,
  // positive=+x, negative=-x across all signal_type values. Reject NaN and
  // out-of-range fail-fast so the row doesn't land with bad data — same
  // discipline as unknown-personality_id rejection.
  const ss = Number(signalStrength);
  if (!Number.isFinite(ss) || ss < -1 || ss > 1) {
    throw new Error(`signal_strength out of range: ${signalStrength} (must be finite number in [-1, 1])`);
  }

  const db = getDb();
  if (!db.prepare('SELECT 1 FROM personalities WHERE id = ?').get(personalityId)) {
    throw new Error(`unknown personality: ${personalityId}`);
  }
  if (writtenBy && !db.prepare('SELECT 1 FROM personalities WHERE id = ?').get(writtenBy)) {
    throw new Error(`unknown written_by: ${writtenBy}`);
  }

  const meta = metadata ? JSON.stringify(metadata) : null;
  const res = db.prepare(`
    INSERT INTO personality_preferences
      (personality_id, key, value, signal_strength, signal_type, source_chunk_id, metadata, written_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(personalityId, key, value, ss, signalType, sourceChunkId, meta, writtenBy);
  const id = Number(res.lastInsertRowid);

  const accepted = [];
  if (relations && relations.length) {
    const insertRel = db.prepare(
      'INSERT OR IGNORE INTO personality_preference_relations (preference_id, object_personality_id) VALUES (?, ?)'
    );
    const hasPersonality = db.prepare('SELECT 1 FROM personalities WHERE id = ?');
    for (const targetId of relations) {
      if (!hasPersonality.get(targetId)) continue;
      insertRel.run(id, targetId);
      accepted.push(targetId);
    }
  }

  return { id, relations: accepted };
}

export function listPreferences({ personalityId, signalType, key, objectPersonalityId, limit = 100, includeAnchors = false, anchorLimit = 5 } = {}) {
  const db = getDb();
  const where = [];
  const params = [];

  if (personalityId) { where.push('p.personality_id = ?'); params.push(personalityId); }
  if (signalType) { where.push('p.signal_type = ?'); params.push(signalType); }
  if (key) { where.push('p.key = ?'); params.push(key); }

  let sql = `
    SELECT p.*,
           (SELECT json_group_array(object_personality_id)
            FROM personality_preference_relations r
            WHERE r.preference_id = p.id) AS relations_json
    FROM personality_preferences p
  `;
  if (objectPersonalityId) {
    sql += ` INNER JOIN personality_preference_relations r ON r.preference_id = p.id AND r.object_personality_id = ? `;
    params.push(objectPersonalityId);
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

export function writeAnchor({ preferenceId, chunkId = null, valence, annotation = null, writtenBy = null }) {
  if (!VALID_VALENCES.has(valence)) {
    throw new Error(`invalid valence: ${valence} (must be reinforces | contradicts | refines)`);
  }
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM personality_preferences WHERE id = ?').get(preferenceId)) {
    throw new Error(`unknown preference_id: ${preferenceId}`);
  }
  if (writtenBy && !db.prepare('SELECT 1 FROM personalities WHERE id = ?').get(writtenBy)) {
    throw new Error(`unknown written_by: ${writtenBy}`);
  }
  const res = db.prepare(`
    INSERT INTO preference_anchors (preference_id, chunk_id, valence, annotation, written_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(preferenceId, chunkId, valence, annotation, writtenBy);
  return { id: Number(res.lastInsertRowid) };
}

export function listAnchors({ preferenceId, limit = 20, newestFirst = true } = {}) {
  if (!preferenceId) throw new Error('preferenceId required');
  const db = getDb();
  const order = newestFirst ? 'DESC' : 'ASC';
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

export function writeFact({ personalityId, category = null, fact, confidence = 0.5, sourceChunkId = null, writtenBy = null }) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM personalities WHERE id = ?').get(personalityId)) {
    throw new Error(`unknown personality: ${personalityId}`);
  }
  if (writtenBy && !db.prepare('SELECT 1 FROM personalities WHERE id = ?').get(writtenBy)) {
    throw new Error(`unknown written_by: ${writtenBy}`);
  }
  const res = db.prepare(`
    INSERT INTO personality_facts (personality_id, category, fact, confidence, source_chunk_id, written_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(personalityId, category, fact, confidence, sourceChunkId, writtenBy);
  return { id: Number(res.lastInsertRowid) };
}

export function listFacts({ personalityId, category, limit = 100 } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (personalityId) { where.push('personality_id = ?'); params.push(personalityId); }
  if (category) { where.push('category = ?'); params.push(category); }
  let sql = 'SELECT * FROM personality_facts';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY confidence DESC, created_at DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// ───────────────────────────────────────────────────────────
// preference_review_queue (tier 2 trigger)
// ───────────────────────────────────────────────────────────

export function enqueueReview({ sessionId, personalityId = null, chunkCount = null }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO preference_review_queue (session_id, personality_id, chunk_count, enqueued_at)
    VALUES (?, ?, ?, unixepoch() * 1000)
    ON CONFLICT(session_id) DO UPDATE SET
      personality_id = excluded.personality_id,
      chunk_count = excluded.chunk_count,
      enqueued_at = excluded.enqueued_at,
      claimed_at = NULL,
      claimed_by = NULL
  `).run(sessionId, personalityId, chunkCount);
  return { sessionId, enqueued: true };
}

export function listPendingReviews({ unclaimedOnly = true, limit = 50 } = {}) {
  const db = getDb();
  const sql = unclaimedOnly
    ? 'SELECT * FROM preference_review_queue WHERE claimed_at IS NULL ORDER BY enqueued_at ASC LIMIT ?'
    : 'SELECT * FROM preference_review_queue ORDER BY enqueued_at ASC LIMIT ?';
  return db.prepare(sql).all(limit);
}

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

export function completeReview(sessionId) {
  const db = getDb();
  const res = db.prepare('DELETE FROM preference_review_queue WHERE session_id = ?').run(sessionId);
  return { sessionId, completed: res.changes > 0 };
}

// ───────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────

function deserialize(row) {
  return {
    ...row,
    displayName: row.display_name || row.name,
    systemPrompt: row.system_prompt || '',
    capabilities: row.capabilities ? tryJSON(row.capabilities) : [],
    restrictions: row.restrictions ? tryJSON(row.restrictions) : [],
    metadata: row.metadata ? tryJSON(row.metadata) : null,
    enabled: row.enabled === undefined ? true : !!row.enabled,
    sfw: row.sfw === undefined ? true : !!row.sfw,
  };
}

function tryJSON(s) { try { return JSON.parse(s); } catch { return s; } }

// ───────────────────────────────────────────────────────────
// legacy aliases — one cycle of backward compat. Callers migrating
// their imports gradually; these wrappers translate old arg names to new.
// ───────────────────────────────────────────────────────────

export const listAgents = listPersonalities;
export const getAgent   = getPersonality;
export function upsertAgent(opts) { return upsertPersonality(opts); }

// Preferences aliases — old callers pass agentId / objectAgentId.
export function listPreferencesLegacy(opts = {}) {
  const { agentId, objectAgentId, ...rest } = opts;
  return listPreferences({ ...rest, personalityId: agentId, objectPersonalityId: objectAgentId });
}
export function writePreferenceLegacy(opts) {
  const { agentId, ...rest } = opts;
  return writePreference({ ...rest, personalityId: agentId });
}
export function writeFactLegacy(opts) {
  const { agentId, ...rest } = opts;
  return writeFact({ ...rest, personalityId: agentId });
}
export function listFactsLegacy(opts = {}) {
  const { agentId, ...rest } = opts;
  return listFacts({ ...rest, personalityId: agentId });
}
export function enqueueReviewLegacy(opts) {
  const { agentId, ...rest } = opts;
  return enqueueReview({ ...rest, personalityId: agentId });
}
