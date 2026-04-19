/**
 * scopes.mjs — project-scope path resolution + session file tracking.
 *
 * Tables live in migrations/0003. This module exposes:
 *   - platform detection (with WSL sub-case)
 *   - scope + path upsert
 *   - path resolver (scope + relative → absolute, platform-aware)
 *   - session_file_touch (auto-scopes via longest-prefix match)
 *   - queries: session_files, file_sessions, files_recent
 *
 * Path normalization: all paths are stored forward-slash normalized.
 * Backslashes (windows) are converted on write. Callers don't have to care.
 */

import { readFileSync, existsSync } from 'fs';
import { getDb } from './db.mjs';

// ───────────────────────────────────────────────────────────
// platform detection
// ───────────────────────────────────────────────────────────

let _cachedPlatform = null;

/**
 * Detect the platform we're running on for path resolution.
 * Returns one of: windows | linux | macos | wsl
 *
 * WSL is distinguished from linux so a box with both windows-mounted
 * and linux-native paths can register separate prefixes. Falls back
 * gracefully to linux if WSL detection fails.
 */
export function detectPlatform() {
  if (_cachedPlatform) return _cachedPlatform;
  const p = process.platform;
  if (p === 'win32') { _cachedPlatform = 'windows'; return _cachedPlatform; }
  if (p === 'darwin') { _cachedPlatform = 'macos'; return _cachedPlatform; }
  // linux, linux-under-WSL, or other unixes
  if (p === 'linux') {
    try {
      if (existsSync('/proc/version')) {
        const ver = readFileSync('/proc/version', 'utf8').toLowerCase();
        if (ver.includes('microsoft') || ver.includes('wsl')) {
          _cachedPlatform = 'wsl';
          return _cachedPlatform;
        }
      }
    } catch { /* fall through to linux */ }
    _cachedPlatform = 'linux';
    return _cachedPlatform;
  }
  _cachedPlatform = p; // openbsd, freebsd, etc. — pass through
  return _cachedPlatform;
}

// Exposed for tests to override
export function _setPlatformForTesting(p) { _cachedPlatform = p; }

// ───────────────────────────────────────────────────────────
// path normalization
// ───────────────────────────────────────────────────────────

/** backslashes → forward slashes; collapse any repeated slashes. */
export function normalizePath(p) {
  if (!p) return p;
  return p.replace(/\\/g, '/').replace(/\/\/+/g, '/');
}

/** Strip trailing slash unless the string is just "/". */
export function stripTrailingSlash(p) {
  if (!p || p === '/') return p;
  return p.endsWith('/') ? p.slice(0, -1) : p;
}

// ───────────────────────────────────────────────────────────
// scope upsert + path registration
// ───────────────────────────────────────────────────────────

export function listScopes() {
  return getDb().prepare('SELECT * FROM project_scopes ORDER BY code').all();
}

export function getScope(code) {
  return getDb().prepare('SELECT * FROM project_scopes WHERE code = ?').get(code);
}

export function upsertScope({ code, name, description = null }) {
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare('SELECT code FROM project_scopes WHERE code = ?').get(code);
  if (existing) {
    db.prepare('UPDATE project_scopes SET name = ?, description = ?, updated_at = ? WHERE code = ?')
      .run(name, description, now, code);
    return { code, updated: true };
  }
  db.prepare('INSERT INTO project_scopes (code, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(code, name, description, now, now);
  return { code, created: true };
}

export function listScopePaths({ scope, platform } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (scope) { where.push('scope = ?'); params.push(scope); }
  if (platform) { where.push('platform = ?'); params.push(platform); }
  let sql = 'SELECT * FROM project_scope_paths';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY scope, platform';
  return db.prepare(sql).all(...params);
}

export function upsertScopePath({ scope, platform, pathPrefix }) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM project_scopes WHERE code = ?').get(scope)) {
    throw new Error(`unknown scope: ${scope}`);
  }
  // Normalize the prefix: forward slashes, trailing slash preserved
  // (path_prefix + relative_path works only if prefix ends with /).
  let prefix = normalizePath(pathPrefix);
  if (!prefix.endsWith('/')) prefix += '/';

  // Check conflict: another scope already owns this prefix for this platform?
  const conflict = db.prepare(
    'SELECT scope FROM project_scope_paths WHERE platform = ? AND path_prefix = ? AND scope != ?'
  ).get(platform, prefix, scope);
  if (conflict) {
    throw new Error(`scope '${conflict.scope}' already owns prefix '${prefix}' on platform '${platform}'`);
  }

  const existing = db.prepare(
    'SELECT path_prefix FROM project_scope_paths WHERE scope = ? AND platform = ?'
  ).get(scope, platform);
  if (existing) {
    db.prepare('UPDATE project_scope_paths SET path_prefix = ? WHERE scope = ? AND platform = ?')
      .run(prefix, scope, platform);
    return { scope, platform, pathPrefix: prefix, updated: true };
  }
  db.prepare('INSERT INTO project_scope_paths (scope, platform, path_prefix) VALUES (?, ?, ?)')
    .run(scope, platform, prefix);
  return { scope, platform, pathPrefix: prefix, created: true };
}

// ───────────────────────────────────────────────────────────
// resolver
// ───────────────────────────────────────────────────────────

/**
 * Resolve a scope + relative path to an absolute path for the current platform.
 * If no path is registered for the detected platform, falls back with a warning.
 * WSL falls back to linux THEN to any platform (matching a common "windows
 * translation if needed" correlation).
 */
export function resolvePath(scope, relativePath) {
  const db = getDb();
  const platform = detectPlatform();
  const rel = normalizePath(relativePath || '');

  // WSL fallback chain: wsl → linux → any
  const candidates = platform === 'wsl' ? ['wsl', 'linux'] : [platform];
  for (const p of candidates) {
    const row = db.prepare('SELECT path_prefix FROM project_scope_paths WHERE scope = ? AND platform = ?').get(scope, p);
    if (row) return row.path_prefix + rel;
  }
  const any = db.prepare('SELECT platform, path_prefix FROM project_scope_paths WHERE scope = ? LIMIT 1').get(scope);
  if (!any) throw new Error(`no path registered for scope '${scope}'`);
  console.error(`[scopes] no ${platform} path for scope '${scope}', falling back to ${any.platform}`);
  return any.path_prefix + rel;
}

// ───────────────────────────────────────────────────────────
// session_files
// ───────────────────────────────────────────────────────────

const VALID_OPERATIONS = new Set(['read', 'edit', 'create', 'delete']);

/**
 * Record a file touch during a session.
 *
 * Auto-scoping: if `path` matches a registered path_prefix (for any platform),
 * the longest prefix wins and path is stored scope-relative. If no match,
 * scope is NULL and path is stored as given.
 *
 * Scope-relative input is also accepted: "scope_code:relative/path" bypasses
 * prefix matching and stores the scope directly.
 */
export function touchSessionFile({ sessionId, path, operation, chunkId = null }) {
  if (!VALID_OPERATIONS.has(operation)) {
    throw new Error(`invalid operation: ${operation} (must be read | edit | create | delete)`);
  }
  const db = getDb();

  let scope = null;
  let storedPath = normalizePath(path);

  // scope-relative form: "scope_code:relative/path"
  const colonIdx = storedPath.indexOf(':');
  if (colonIdx > 0 && colonIdx < 32) {
    const maybeScope = storedPath.slice(0, colonIdx);
    if (/^[a-zA-Z0-9_-]+$/.test(maybeScope) &&
        db.prepare('SELECT 1 FROM project_scopes WHERE code = ?').get(maybeScope)) {
      // looks like scope-relative and the scope exists
      scope = maybeScope;
      storedPath = storedPath.slice(colonIdx + 1);
    }
  }

  // Otherwise try longest-prefix match across all registered paths
  if (!scope) {
    const rows = db.prepare(
      'SELECT scope, path_prefix FROM project_scope_paths ORDER BY LENGTH(path_prefix) DESC'
    ).all();
    for (const row of rows) {
      if (storedPath.startsWith(row.path_prefix)) {
        scope = row.scope;
        storedPath = storedPath.slice(row.path_prefix.length);
        break;
      }
    }
  }

  const res = db.prepare(`
    INSERT INTO session_files (session_id, chunk_id, scope, path, operation)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, chunkId, scope, storedPath, operation);

  return { id: Number(res.lastInsertRowid), sessionId, scope, path: storedPath, operation };
}

/**
 * List file activity for a session.
 */
export function listSessionFiles(sessionId, { limit = 100 } = {}) {
  return getDb().prepare(`
    SELECT * FROM session_files
    WHERE session_id = ?
    ORDER BY occurred_at DESC, id DESC
    LIMIT ?
  `).all(sessionId, limit);
}

/**
 * Reverse lookup: which sessions touched this path?
 */
export function listFileSessions({ scope, path, limit = 50 } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (scope) { where.push('scope = ?'); params.push(scope); }
  if (path) { where.push('path = ?'); params.push(normalizePath(path)); }
  if (where.length === 0) throw new Error('listFileSessions requires at least scope or path');
  const sql = `
    SELECT * FROM session_files
    WHERE ${where.join(' AND ')}
    ORDER BY occurred_at DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params, limit);
}

/**
 * Recent file activity across sessions.
 */
export function listRecentFiles({ scope, limit = 20 } = {}) {
  const db = getDb();
  let sql = 'SELECT * FROM session_files';
  const params = [];
  if (scope) { sql += ' WHERE scope = ?'; params.push(scope); }
  sql += ' ORDER BY occurred_at DESC, id DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// ───────────────────────────────────────────────────────────
// backfill: link unlinked session_files to the chunk that just wrote
// ───────────────────────────────────────────────────────────

/**
 * Called by insertChunk after it writes a new chunk. Links all session_files
 * rows for this session with chunk_id IS NULL to the new chunk.
 *
 * Semantics: tool calls (file touches) fire DURING a turn, before the chunk
 * representing that turn is written. When the turn completes and its chunk
 * is inserted, the preceding tool activity gets attributed to it. The next
 * turn starts with no pending unlinked rows.
 *
 * Idempotent and cheap (indexed lookup on session_id WHERE chunk_id IS NULL).
 *
 * @returns {number} number of rows linked
 */
export function backfillChunkIdForSession(sessionId, chunkId) {
  if (!sessionId || !chunkId) return 0;
  const db = getDb();
  const res = db.prepare(`
    UPDATE session_files
    SET chunk_id = ?
    WHERE session_id = ? AND chunk_id IS NULL
  `).run(chunkId, sessionId);
  return res.changes;
}
