-- 0006 — drop the agents/personalities duality, rename agents → personalities,
-- absorb behavior columns, rename all agent_id → personality_id.
--
-- Single source of truth: `personalities` table. One row per girl/agent.
-- One personality per girl, mode-filtering via `personality_traits` rows
-- at L1 build time (future stage).
--
-- No data migration from the OLD runtime-created `personalities` table —
-- its schema varied by when personality.mjs last ran, and we can't
-- reliably ALTER-to-full-shape in pure SQL. All new behavior columns
-- populate from DEFAULTs (enabled=1, sfw=1, active=0). Operators who had
-- non-default state (e.g. sfw=0 on one personality) re-apply via
-- `personality_rate` / `personality_disable` MCP tools after the rename.
-- personality_files (identity.md etc.) is unaffected — separate table.
--
-- Breaking change. Callers (core/*.mjs, mcp-server.mjs, scripts, hooks,
-- wmem clients) must update.

BEGIN TRANSACTION;

-- ───────────────────────────────────────────────────────────────
-- 1. Add behavior columns to agents (all NEW, from DEFAULTs).
-- ───────────────────────────────────────────────────────────────
ALTER TABLE agents ADD COLUMN display_name  TEXT;
ALTER TABLE agents ADD COLUMN description   TEXT;
ALTER TABLE agents ADD COLUMN system_prompt TEXT;
ALTER TABLE agents ADD COLUMN voice         TEXT;
ALTER TABLE agents ADD COLUMN capabilities  TEXT;   -- JSON array
ALTER TABLE agents ADD COLUMN restrictions  TEXT;   -- JSON array
ALTER TABLE agents ADD COLUMN born          TEXT;
ALTER TABLE agents ADD COLUMN avatar        TEXT;
ALTER TABLE agents ADD COLUMN enabled       INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN sfw           INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN active        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN updated_at    INTEGER;

-- ───────────────────────────────────────────────────────────────
-- 2. Drop the old personalities table if it exists (runtime-created by
--    the pre-rename personality.mjs). personality_files is a separate
--    table and is preserved — identity.md / voice.md etc. stay intact.
-- ───────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS personalities;

-- ───────────────────────────────────────────────────────────────
-- 3. Rename agents → personalities (the unified table).
-- ───────────────────────────────────────────────────────────────
ALTER TABLE agents RENAME TO personalities;

-- ───────────────────────────────────────────────────────────────
-- 4. Rename the agent_* ancillary tables.
--
-- agent_aliases is deliberately OMITTED here — it was never created by
-- migration 0001 (it was a runtime table born in core/db.mjs init).
-- On fresh DBs post-rename, core/db.mjs now creates personality_aliases
-- directly, so there is no agent_aliases to rename. On upgrade DBs that
-- had agent_aliases from the old db.mjs, migration 0007 drops it as an
-- orphan; the renamed db.mjs creates personality_aliases on next boot.
-- Either path ends with personality_aliases only — no data loss since
-- both tables were empty at cutover (verified on master canonical).
-- ───────────────────────────────────────────────────────────────
ALTER TABLE agent_personality_facts      RENAME TO personality_facts;
ALTER TABLE agent_preferences            RENAME TO personality_preferences;
ALTER TABLE agent_preference_relations   RENAME TO personality_preference_relations;

-- ───────────────────────────────────────────────────────────────
-- 5. Rename agent_id → personality_id columns.
--    SQLite 3.26+ propagates FK references on RENAME COLUMN.
-- ───────────────────────────────────────────────────────────────
ALTER TABLE personality_facts                  RENAME COLUMN agent_id        TO personality_id;
ALTER TABLE personality_preferences            RENAME COLUMN agent_id        TO personality_id;
ALTER TABLE personality_preference_relations   RENAME COLUMN object_agent_id TO object_personality_id;
ALTER TABLE capabilities                       RENAME COLUMN agent_id        TO personality_id;
ALTER TABLE preference_review_queue            RENAME COLUMN agent_id        TO personality_id;

-- ───────────────────────────────────────────────────────────────
-- 6+7. Deliberately NOT renaming chunks.agent or messages.from_agent /
-- to_agent. They're plain TEXT columns (no FK name-binding). Renaming
-- would churn ~30 SQL queries in core/db.mjs + messages handlers for
-- zero semantic gain — the scope target is FK-carrying columns
-- (agent_id → personality_id), not every literal string 'agent'.
--
-- Post-migration:
--   chunks.agent         → still stores personality.id values
--   messages.from_agent  → still references personalities(id) via FK
--   messages.to_agent    → still references personalities(id) via FK
-- FKs follow the renamed `agents → personalities` table automatically
-- (SQLite 3.26+ rewrites sqlite_master on RENAME TO).

-- ───────────────────────────────────────────────────────────────
-- 8. Rename indexes that had agent in their name.
--    (SQLite doesn't support RENAME INDEX directly — drop + recreate.)
-- ───────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_agent_facts_written_by;
DROP INDEX IF EXISTS idx_agent_prefs_written_by;
DROP INDEX IF EXISTS idx_bookmarks_agent;
DROP INDEX IF EXISTS idx_capabilities_agent;
DROP INDEX IF EXISTS idx_chunks_agent;
DROP INDEX IF EXISTS idx_facts_agent;
DROP INDEX IF EXISTS idx_pref_agent_domain;
DROP INDEX IF EXISTS idx_pref_rel_object;
DROP INDEX IF EXISTS idx_pref_subject;
DROP INDEX IF EXISTS idx_prefs_agent_key;
DROP INDEX IF EXISTS idx_prefs_agent_type;
DROP INDEX IF EXISTS idx_sessions_agent;

CREATE INDEX IF NOT EXISTS idx_personality_facts_written_by ON personality_facts(written_by);
CREATE INDEX IF NOT EXISTS idx_personality_prefs_written_by ON personality_preferences(written_by);
CREATE INDEX IF NOT EXISTS idx_capabilities_personality     ON capabilities(personality_id);
CREATE INDEX IF NOT EXISTS idx_chunks_agent                 ON chunks(agent);
CREATE INDEX IF NOT EXISTS idx_facts_personality            ON personality_facts(personality_id, category);
CREATE INDEX IF NOT EXISTS idx_pref_rel_object              ON personality_preference_relations(object_personality_id);
CREATE INDEX IF NOT EXISTS idx_prefs_personality_key        ON personality_preferences(personality_id, key);
CREATE INDEX IF NOT EXISTS idx_prefs_personality_type       ON personality_preferences(personality_id, signal_type);

-- (idx_bookmarks_agent, idx_messages_*, idx_pref_agent_domain, idx_pref_subject,
--  idx_sessions_agent recreated lazily by the existing create-if-not-exists paths
--  in core/db.mjs at first call — keeping migration minimal.)

COMMIT;
