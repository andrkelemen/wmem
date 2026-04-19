-- 0005_capabilities.sql
--
-- Capabilities registry: per-agent declaration of tools, services, hardware,
-- installations. Answers "who can do X?" for multi-agent workload routing.
-- A future confidence-model companion would extend this for "who is CURRENTLY RELIABLE at X?"
--
-- Design notes:
--   - category is free-text (TEXT, no CHECK) — convention documented in README,
--     not enforced. Users define their own categories (tool|service|hardware|
--     ml|io|installation|meta|...).
--   - tier: 'primary'|'standard'|'fallback' — feeds capability_match ranking.
--   - requires + metadata are loose JSON; no pre-defined shape.
--   - FTS5 virtual table indexes name/description/tags for capability_lookup.
--   - Spoof-impossible: every write stamps agent_id from MCP caller identity,
--     not from a user-supplied parameter. Enforced at the MCP tool layer.

BEGIN TRANSACTION;

-- ───────────────────────────────────────────────────────────
-- capabilities — one row per (agent, name)
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS capabilities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT    NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  category        TEXT    NOT NULL,
  description     TEXT,
  location        TEXT,
  version         TEXT,
  requires        TEXT,    -- JSON: { deps, env, gpu, network, disk }
  tier            TEXT    NOT NULL DEFAULT 'standard',
  status          TEXT    NOT NULL DEFAULT 'active',
  added_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_verified   INTEGER,
  metadata        TEXT,    -- JSON: { tags: [...], examples: [...], cost, notes }
  UNIQUE(agent_id, name)
);

CREATE INDEX IF NOT EXISTS idx_capabilities_agent    ON capabilities(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_capabilities_name     ON capabilities(name);
CREATE INDEX IF NOT EXISTS idx_capabilities_category ON capabilities(category, status);
CREATE INDEX IF NOT EXISTS idx_capabilities_verified ON capabilities(last_verified);

-- ───────────────────────────────────────────────────────────
-- capabilities_fts — FTS5 index for capability_lookup
-- ───────────────────────────────────────────────────────────
-- content='capabilities' + content_rowid='id' keeps FTS in lockstep with the
-- main table. Triggers below propagate inserts/updates/deletes.
CREATE VIRTUAL TABLE IF NOT EXISTS capabilities_fts USING fts5(
  name,
  description,
  tags,
  content='capabilities',
  content_rowid='id'
);

-- Trigger: on insert, extract tags (from metadata.tags JSON array) + index
CREATE TRIGGER IF NOT EXISTS capabilities_ai AFTER INSERT ON capabilities BEGIN
  INSERT INTO capabilities_fts(rowid, name, description, tags) VALUES (
    new.id,
    new.name,
    COALESCE(new.description, ''),
    COALESCE((SELECT group_concat(value, ' ') FROM json_each(json_extract(new.metadata, '$.tags'))), '')
  );
END;

-- Trigger: on delete, remove from FTS
CREATE TRIGGER IF NOT EXISTS capabilities_ad AFTER DELETE ON capabilities BEGIN
  INSERT INTO capabilities_fts(capabilities_fts, rowid, name, description, tags) VALUES (
    'delete', old.id, old.name, COALESCE(old.description, ''), ''
  );
END;

-- Trigger: on update, re-sync FTS row
CREATE TRIGGER IF NOT EXISTS capabilities_au AFTER UPDATE ON capabilities BEGIN
  INSERT INTO capabilities_fts(capabilities_fts, rowid, name, description, tags) VALUES (
    'delete', old.id, old.name, COALESCE(old.description, ''), ''
  );
  INSERT INTO capabilities_fts(rowid, name, description, tags) VALUES (
    new.id,
    new.name,
    COALESCE(new.description, ''),
    COALESCE((SELECT group_concat(value, ' ') FROM json_each(json_extract(new.metadata, '$.tags'))), '')
  );
END;

COMMIT;
