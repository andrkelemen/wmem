-- 0004_messages_and_written_by.sql
--
-- Two concerns landing together because they're the same axis:
--   wmem becomes the inter-agent message bus (messages table)
--   every row knows which agent's call created it (written_by columns)
--
-- Both need caller identity to be first-class. HTTP surface reads X-Caller
-- header; MCP surface reads WMEM_CALLER env var (set per-agent in their
-- claude code config). NULL is the graceful degraded state — writes still
-- work, they just don't carry attribution. No break on missing identity.
--
-- Naming notes:
--   - from_agent / to_agent instead of from/to to avoid SQL reserved words
--   - messages.parent_id → messages(id) self-reference for threading
--   - metadata is loose JSON, convention documented in code, no CHECK

BEGIN TRANSACTION;

-- ───────────────────────────────────────────────────────────
-- messages — agent-to-agent mail
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL REFERENCES agents(id),
  to_agent TEXT NOT NULL REFERENCES agents(id),
  subject TEXT,
  body TEXT NOT NULL,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  read INTEGER NOT NULL DEFAULT 0,
  read_at INTEGER,
  parent_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  metadata TEXT   -- JSON: source, delivery_status, thread_depth (free-form)
);
CREATE INDEX IF NOT EXISTS idx_messages_to_unread ON messages(to_agent, read, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages(parent_id) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

-- ───────────────────────────────────────────────────────────
-- written_by — author attribution on existing tables
-- ───────────────────────────────────────────────────────────
--
-- Semantics: agent_id = SUBJECT of row. written_by = AUTHOR of the MCP/HTTP
-- call that created it. Distinct concepts. Example: agent-alpha writes a preference
-- about agent-beta → agent_id=agent-beta, written_by=agent-alpha.
--
-- JSONL-replay imports and backfill-extracted rows stay written_by=NULL.
-- That's honest — they were born outside attributed calls, not broken.
--
-- ALTER TABLE ADD COLUMN is always nullable in SQLite, which is what we
-- want (graceful degradation). FK enforcement against agents.id is done at
-- the application layer on write — SQLite doesn't enforce FKs added via
-- ALTER TABLE reliably.
ALTER TABLE chunks ADD COLUMN written_by TEXT;
ALTER TABLE agent_preferences ADD COLUMN written_by TEXT;
ALTER TABLE agent_personality_facts ADD COLUMN written_by TEXT;
ALTER TABLE preference_anchors ADD COLUMN written_by TEXT;

CREATE INDEX IF NOT EXISTS idx_chunks_written_by ON chunks(written_by) WHERE written_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_prefs_written_by ON agent_preferences(written_by) WHERE written_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_facts_written_by ON agent_personality_facts(written_by) WHERE written_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_anchors_written_by ON preference_anchors(written_by) WHERE written_by IS NOT NULL;

COMMIT;
