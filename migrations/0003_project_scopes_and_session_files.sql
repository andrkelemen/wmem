-- 0003_project_scopes_and_session_files.sql
--
-- Phase 1 of issue #35: portable path resolution + file-level activity tracking.
-- Three new tables:
--   project_scopes            — logical project identifiers (backend, frontend, etc.)
--   project_scope_paths       — platform-specific path prefixes per scope (tall table)
--   session_files             — which files were read/edited/created/deleted in each session
--
-- Phase 2 (chunk_scopes + scope-aware memory_search) is a separate migration.
--
-- Design notes:
--   - project_scope_paths is TALL (one row per platform) so new platforms
--     (wsl, docker, ios, ssh) land without ALTER TABLE
--   - platform column is free-form TEXT (no CHECK); canonical values are
--     documented in code. typos fail loud on resolve; easier to maintain
--     than an ever-growing enum.
--   - session_files.path is forward-slash normalized at write time.
--   - session_files.chunk_id is nullable; populated by insertChunk at
--     chunk-write time (backfill from session-unlinked rows).
--   - auto-scoping: on write, longest-matching path_prefix wins. If match,
--     path is stored scope-relative and scope is set. If no match, scope
--     is NULL and path is stored as given (absolute).

BEGIN TRANSACTION;

-- ───────────────────────────────────────────────────────────
-- project_scopes — one row per logical project
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_scopes (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ───────────────────────────────────────────────────────────
-- project_scope_paths — one row per (scope, platform)
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_scope_paths (
  scope TEXT NOT NULL REFERENCES project_scopes(code) ON DELETE CASCADE,
  platform TEXT NOT NULL,      -- windows | linux | macos | wsl | docker | ios | android | ...
  path_prefix TEXT NOT NULL,
  PRIMARY KEY (scope, platform)
);
CREATE INDEX IF NOT EXISTS idx_psp_platform ON project_scope_paths(platform);
CREATE INDEX IF NOT EXISTS idx_psp_prefix ON project_scope_paths(path_prefix);

-- ───────────────────────────────────────────────────────────
-- session_files — file activity per session
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  chunk_id INTEGER REFERENCES chunks(id) ON DELETE SET NULL,
  scope TEXT REFERENCES project_scopes(code) ON DELETE SET NULL,
  path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('read', 'edit', 'create', 'delete')),
  occurred_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_sf_session ON session_files(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_sf_scope_path ON session_files(scope, path, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_sf_path ON session_files(path);
CREATE INDEX IF NOT EXISTS idx_sf_session_unlinked ON session_files(session_id)
  WHERE chunk_id IS NULL;

-- ───────────────────────────────────────────────────────────
-- Seed (generic example from issue #35; users customize via MCP)
-- ───────────────────────────────────────────────────────────
INSERT OR IGNORE INTO project_scopes (code, name, description) VALUES
  ('frontend', 'App frontend',  'Public-facing UI'),
  ('admin',    'App admin UI',  'Admin console'),
  ('backend',  'App backend',   'API server'),
  ('database', 'App database',  'DB schema and stored procs');

-- Example paths intentionally left EMPTY — users register real paths for their
-- machines via project_scope_path_upsert. The seed scopes are placeholders
-- showing the shape; delete them or reuse as-is.

COMMIT;
