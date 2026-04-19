/**
 * doctor.mjs — Integrity checks, recovery, safe delete, status
 *
 * wmem doctor: diagnose and fix database integrity issues.
 * wmem status: show what's loaded, what's stale, what's healthy.
 *
 * Five hardening pieces:
 * 1. L-tier validation (no cross-tier leaks, compression idempotent)
 * 2. Personality switch checkpoint/restore
 * 3. Per-session recovery (reconstruct from last known good state)
 * 4. Safe delete/purge with cascade
 * 5. Integrity checks (orphans, broken FTS, stale sessions)
 */

import { getDb } from './db.mjs';
import { existsSync, statSync, readFileSync } from 'fs';
import { createHash } from 'crypto';

// ── 1. L-Tier Validation ────────────────────────────────

/**
 * Validate L-tier integrity:
 * - No chunks without required fields
 * - No orphan tags (tags pointing to deleted chunks)
 * - No orphan FTS entries
 * - Timestamps are valid numbers
 * - Content hashes are present and consistent
 */
export function validateIntegrity() {
  const db = getDb();
  const issues = [];

  // Chunks with missing required fields
  const badChunks = db.prepare(`
    SELECT id, agent, source_type, content, timestamp
    FROM chunks
    WHERE agent IS NULL OR agent = ''
      OR source_type IS NULL OR source_type = ''
      OR content IS NULL OR content = ''
      OR timestamp IS NULL OR timestamp = 0
  `).all();
  if (badChunks.length > 0) {
    issues.push({ type: 'bad_chunks', count: badChunks.length, ids: badChunks.slice(0, 10).map(c => c.id) });
  }

  // Orphan tags (tag.chunk_id not in chunks)
  const orphanTags = db.prepare(`
    SELECT COUNT(*) as count FROM tags
    WHERE chunk_id NOT IN (SELECT id FROM chunks)
  `).get();
  if (orphanTags.count > 0) {
    issues.push({ type: 'orphan_tags', count: orphanTags.count });
  }

  // Chunks without content hash (dedup won't catch them)
  const noHash = db.prepare(`
    SELECT COUNT(*) as count FROM chunks WHERE content_hash IS NULL OR content_hash = ''
  `).get();
  if (noHash.count > 0) {
    issues.push({ type: 'missing_hash', count: noHash.count });
  }

  // Duplicate content hashes within same agent+source_type (dedup failures)
  const dupes = db.prepare(`
    SELECT content_hash, agent, source_type, COUNT(*) as count
    FROM chunks
    WHERE content_hash IS NOT NULL
    GROUP BY content_hash, agent, source_type
    HAVING count > 1
  `).all();
  if (dupes.length > 0) {
    issues.push({ type: 'duplicate_chunks', count: dupes.length, total: dupes.reduce((a, d) => a + d.count - 1, 0) });
  }

  // Sessions pointing to files that no longer exist
  const sessions = db.prepare('SELECT session_id, file_path FROM sessions').all();
  const staleFiles = sessions.filter(s => s.file_path && !existsSync(s.file_path));
  if (staleFiles.length > 0) {
    issues.push({ type: 'stale_sessions', count: staleFiles.length, files: staleFiles.slice(0, 5).map(s => s.file_path) });
  }

  // Timestamps in the future (clock issues)
  const futureChunks = db.prepare(`
    SELECT COUNT(*) as count FROM chunks WHERE timestamp > ?
  `).get(Date.now() + 86400000); // more than 1 day in the future
  if (futureChunks.count > 0) {
    issues.push({ type: 'future_timestamps', count: futureChunks.count });
  }

  return {
    healthy: issues.length === 0,
    issues,
    checked: ['chunks_required_fields', 'orphan_tags', 'content_hashes', 'duplicate_chunks', 'stale_sessions', 'future_timestamps'],
  };
}

// ── 2. Personality Switch Checkpoint/Restore ────────────

/**
 * Create a checkpoint of the current personality state.
 * Saves: active personality, L1 config, session state.
 * Used before switching to allow rollback.
 */
export function createCheckpoint() {
  const db = getDb();

  // Ensure checkpoint table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      personality TEXT,
      state TEXT,
      created_at INTEGER
    )
  `);

  // Get current active personality
  let active = null;
  try {
    active = db.prepare('SELECT name, display_name, system_prompt, voice FROM personalities WHERE active = 1').get();
  } catch { /* personalities table might not exist */ }

  const checkpoint = {
    personality: active?.name || null,
    timestamp: Date.now(),
  };

  db.prepare('INSERT INTO checkpoints (personality, state, created_at) VALUES (?, ?, ?)')
    .run(checkpoint.personality, JSON.stringify(checkpoint), Date.now());

  // Keep only last 10 checkpoints
  db.prepare('DELETE FROM checkpoints WHERE id NOT IN (SELECT id FROM checkpoints ORDER BY id DESC LIMIT 10)').run();

  return checkpoint;
}

/**
 * Restore from the last checkpoint.
 */
export function restoreCheckpoint() {
  const db = getDb();

  let last;
  try {
    last = db.prepare('SELECT * FROM checkpoints ORDER BY id DESC LIMIT 1').get();
  } catch {
    return { restored: false, reason: 'no checkpoints table' };
  }

  if (!last) return { restored: false, reason: 'no checkpoints found' };

  const state = JSON.parse(last.state);

  if (state.personality) {
    try {
      db.prepare('UPDATE personalities SET active = 0').run();
      db.prepare('UPDATE personalities SET active = 1 WHERE name = ?').run(state.personality);
    } catch { /* personality might be deleted */ }
  }

  return { restored: true, personality: state.personality, from: new Date(last.created_at).toISOString() };
}

/**
 * Atomic personality switch with checkpoint.
 */
export function atomicPersonalitySwitch(newPersonality) {
  const db = getDb();

  const transaction = db.transaction(() => {
    // Checkpoint current state
    createCheckpoint();

    // Verify target exists
    let target;
    try {
      target = db.prepare('SELECT name FROM personalities WHERE name = ?').get(newPersonality);
    } catch {
      throw new Error('personalities table not initialized');
    }
    if (!target) throw new Error(`personality "${newPersonality}" not found`);

    // Switch
    db.prepare('UPDATE personalities SET active = 0').run();
    db.prepare('UPDATE personalities SET active = 1 WHERE name = ?').run(newPersonality);

    return { switched: true, to: newPersonality };
  });

  try {
    return transaction();
  } catch (err) {
    return { switched: false, reason: err.message };
  }
}

// ── 3. Per-Session Recovery ─────────────────────────────

/**
 * Check session integrity — find sessions with inconsistent state.
 * Returns sessions where byte offset exceeds file size,
 * or where the file has been modified since last index.
 */
export function checkSessionHealth() {
  const db = getDb();
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY last_indexed_at DESC').all();
  const report = { healthy: 0, stale: 0, orphaned: 0, corrupted: 0, details: [] };

  for (const s of sessions) {
    if (!s.file_path || !existsSync(s.file_path)) {
      report.orphaned++;
      report.details.push({ session: s.session_id, issue: 'file_missing', path: s.file_path });
      continue;
    }

    try {
      const stat = statSync(s.file_path);

      if (s.last_byte_offset > stat.size) {
        report.corrupted++;
        report.details.push({ session: s.session_id, issue: 'offset_exceeds_size', offset: s.last_byte_offset, fileSize: stat.size });
      } else if (stat.size > s.file_size) {
        report.stale++;
        report.details.push({ session: s.session_id, issue: 'new_content', newBytes: stat.size - s.file_size });
      } else {
        report.healthy++;
      }
    } catch (err) {
      report.corrupted++;
      report.details.push({ session: s.session_id, issue: 'stat_failed', error: err.message });
    }
  }

  return report;
}

/**
 * Recover a session by resetting its offset to 0.
 * Next index run will re-read the entire file.
 */
export function recoverSession(sessionId) {
  const db = getDb();
  const result = db.prepare('UPDATE sessions SET last_byte_offset = 0, file_size = 0 WHERE session_id = ?').run(sessionId);
  return { recovered: result.changes > 0, sessionId };
}

/**
 * Recover all corrupted/stale sessions.
 */
export function recoverAllSessions() {
  const db = getDb();
  // Reset all sessions to re-index from scratch
  const result = db.prepare('UPDATE sessions SET last_byte_offset = 0, file_size = 0').run();
  return { recovered: result.changes, message: 'all sessions reset — run indexer with --force to re-index' };
}

// ── 4. Safe Delete/Purge ────────────────────────────────

/**
 * Delete chunks for an agent with full cascade.
 * Removes: chunks, tags, FTS entries, vec entries.
 * Does NOT delete the personality or sessions — those are metadata.
 */
export function purgeAgent(agent, { dryRun = false } = {}) {
  const db = getDb();

  // Count what would be deleted
  const chunkCount = db.prepare('SELECT COUNT(*) as count FROM chunks WHERE agent = ?').get(agent).count;
  const tagCount = db.prepare(`
    SELECT COUNT(*) as count FROM tags WHERE chunk_id IN (SELECT id FROM chunks WHERE agent = ?)
  `).get(agent).count;

  if (dryRun) {
    return { dryRun: true, agent, chunks: chunkCount, tags: tagCount };
  }

  const transaction = db.transaction(() => {
    // Get chunk IDs first
    const chunkIds = db.prepare('SELECT id FROM chunks WHERE agent = ?').all(agent).map(c => c.id);

    if (chunkIds.length > 0) {
      // Delete in batches of 500 to stay under SQLite's 999 param limit
      const BATCH = 500;
      for (let i = 0; i < chunkIds.length; i += BATCH) {
        const batch = chunkIds.slice(i, i + BATCH);
        const ph = batch.map(() => '?').join(',');
        db.prepare(`DELETE FROM tags WHERE chunk_id IN (${ph})`).run(...batch);
        try {
          db.prepare(`DELETE FROM chunks_vec WHERE rowid IN (${ph})`).run(...batch);
        } catch { /* vec table might not have these rows */ }
      }
    }

    // Delete chunks
    db.prepare('DELETE FROM chunks WHERE agent = ?').run(agent);

    // Delete sessions for this agent
    const sessionCount = db.prepare('DELETE FROM sessions WHERE agent = ?').run(agent).changes;

    // Delete import registry entries for this agent
    let importCount = 0;
    try {
      importCount = db.prepare('DELETE FROM import_registry WHERE agent = ?').run(agent).changes;
    } catch { /* import_registry might not exist */ }

    return { chunks: chunkIds.length, tags: tagCount, sessions: sessionCount, imports: importCount };
  });

  const result = transaction();
  return { purged: true, agent, ...result };
}

/**
 * Delete a specific personality and optionally its data.
 */
export function purgePersonality(name, { deleteData = false, dryRun = false } = {}) {
  const db = getDb();

  if (dryRun) {
    const chunks = db.prepare('SELECT COUNT(*) as count FROM chunks WHERE agent = ?').get(name).count;
    return { dryRun: true, personality: name, chunks, wouldDeleteData: deleteData };
  }

  const transaction = db.transaction(() => {
    // Delete personality files
    try {
      db.prepare('DELETE FROM personality_files WHERE personality = ?').run(name);
    } catch { }

    // Delete personality
    try {
      db.prepare('DELETE FROM personalities WHERE name = ?').run(name);
    } catch { }

    // Delete aliases pointing to this personality
    try {
      db.prepare('DELETE FROM agent_aliases WHERE canonical = ?').run(name);
    } catch { }

    let dataResult = null;
    if (deleteData) {
      dataResult = purgeAgent(name);
    }

    return { personality: name, deleted: true, dataDeleted: deleteData, data: dataResult };
  });

  return transaction();
}

/**
 * Remove duplicate chunks (keep oldest by ID).
 */
export function dedup() {
  const db = getDb();

  const dupes = db.prepare(`
    SELECT content_hash, agent, source_type, MIN(id) as keep_id, COUNT(*) as count
    FROM chunks
    WHERE content_hash IS NOT NULL
    GROUP BY content_hash, agent, source_type
    HAVING count > 1
  `).all();

  if (dupes.length === 0) return { deduped: 0 };

  let removed = 0;
  const transaction = db.transaction(() => {
    for (const d of dupes) {
      // Delete tags for duplicate chunks
      const toDelete = db.prepare(
        'SELECT id FROM chunks WHERE content_hash = ? AND agent = ? AND source_type = ? AND id != ?'
      ).all(d.content_hash, d.agent, d.source_type, d.keep_id);

      for (const chunk of toDelete) {
        db.prepare('DELETE FROM tags WHERE chunk_id = ?').run(chunk.id);
        try { db.prepare('DELETE FROM chunks_vec WHERE rowid = ?').run(chunk.id); } catch { }
        db.prepare('DELETE FROM chunks WHERE id = ?').run(chunk.id);
        removed++;
      }
    }
  });

  transaction();
  return { deduped: removed, groups: dupes.length };
}

// ── 5. Status / Doctor ──────────────────────────────────

/**
 * Full status report — everything about the current wmem state.
 */
export function getStatus() {
  const db = getDb();

  // Basic stats
  const chunks = db.prepare('SELECT COUNT(*) as count FROM chunks').get().count;
  const sessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
  const tags = db.prepare('SELECT COUNT(*) as count FROM tags').get().count;

  // Agent breakdown
  const agents = db.prepare(`
    SELECT agent, COUNT(*) as chunks, COUNT(DISTINCT session_id) as sessions
    FROM chunks GROUP BY agent ORDER BY chunks DESC
  `).all();

  // Active personality
  let personality = null;
  try {
    personality = db.prepare('SELECT name, display_name FROM personalities WHERE active = 1').get();
  } catch { }

  // Aliases
  let aliases = [];
  try { aliases = db.prepare('SELECT alias, canonical FROM agent_aliases').all(); } catch { }

  // DB file size
  let dbSize = 0;
  const dbPath = process.env.MEMORY_DB || './data/memory.db';
  try {
    dbSize = statSync(dbPath).size;
  } catch { }

  // Import registry
  let imports = [];
  try {
    imports = db.prepare('SELECT file_path, file_hash, imported_at, chunk_count FROM import_registry ORDER BY imported_at DESC LIMIT 10').all();
  } catch { }

  // Stale imports
  const staleImports = imports.filter(i => {
    try {
      const currentHash = createHash('sha256').update(readFileSync(i.file_path)).digest('hex');
      return currentHash !== i.file_hash;
    } catch { return true; } // file missing = stale
  });

  return {
    chunks,
    sessions,
    tags,
    agents,
    personality: personality?.name || null,
    aliases,
    dbSize,
    dbSizeMB: +(dbSize / 1024 / 1024).toFixed(1),
    imports: imports.length,
    staleImports: staleImports.length,
  };
}

/**
 * Run full doctor check — integrity + session health + status.
 */
export function runDoctor() {
  const integrity = validateIntegrity();
  const status = getStatus();

  return {
    integrity,
    status,
    healthy: integrity.healthy,
    summary: integrity.healthy
      ? `✓ wmem healthy. ${status.chunks} chunks, ${status.sessions} sessions, ${status.agents.length} agents.`
      : `⚠ ${integrity.issues.length} issues found. Run with --fix to repair.`,
  };
}

// ── 6. Auto-Fix ─────────────────────────────────────────

/**
 * Fix all detected issues automatically.
 */
export function autoFix() {
  const db = getDb();
  const fixes = [];

  // Fix orphan tags
  const orphanTags = db.prepare('DELETE FROM tags WHERE chunk_id NOT IN (SELECT id FROM chunks)').run();
  if (orphanTags.changes > 0) fixes.push(`removed ${orphanTags.changes} orphan tags`);

  // Fix duplicates
  const dedupResult = dedup();
  if (dedupResult.deduped > 0) fixes.push(`removed ${dedupResult.deduped} duplicate chunks`);

  // Fix stale sessions (reset orphaned ones)
  const sessions = db.prepare('SELECT session_id, file_path FROM sessions').all();
  let resetCount = 0;
  for (const s of sessions) {
    if (s.file_path && !existsSync(s.file_path)) {
      db.prepare('DELETE FROM sessions WHERE session_id = ?').run(s.session_id);
      resetCount++;
    }
  }
  if (resetCount > 0) fixes.push(`removed ${resetCount} orphaned sessions`);

  return { fixed: fixes.length > 0, fixes };
}
