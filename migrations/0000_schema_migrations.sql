-- 0000_schema_migrations.sql
--
-- Bootstrap migration — documents the tracking table shape.
-- The runner creates this table inline before applying any migration,
-- so this file is effectively idempotent metadata.
--
-- Columns:
--   filename    — migration filename, primary key
--   applied_at  — unix-ms timestamp when migration applied cleanly

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
