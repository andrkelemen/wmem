-- 0001_agent_tables.sql
--
-- First-class agent identity, personality facts, and preferences.
-- Enables the preference-consolidation pipeline:
--   tier 1 (signal)  — preference_signals, written by the regex extractor
--   tier 2 (pref)    — agent_preferences, written by agents via MCP tools
--                      after a SessionEnd hook enqueues review tasks
--   tier 3 (fact)    — agent_personality_facts, promoted from repeated prefs
--
-- Zero-LLM on wmem's side. The agent (already an LLM) does the consolidation
-- via MCP tools exposed by wmem: preferences_write, preferences_list,
-- preferences_pending, facts_write, facts_list.

BEGIN TRANSACTION;

-- ───────────────────────────────────────────────────────────
-- agents — one row per agent the memory system knows about
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,                        -- free-form: 'coder', 'architect', 'user', etc.
  metadata TEXT,                    -- JSON; UI/display data (color, icon, etc.)
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- ───────────────────────────────────────────────────────────
-- agent_personality_facts — stable identity statements
-- Example: {agent: 'coder', category: 'voice', fact: 'terse by default'}
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_personality_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  category TEXT,                    -- voice | register | behavior | identity | ...
  fact TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,      -- 0.0–1.0
  source_chunk_id INTEGER,          -- optional backlink to originating chunk
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_facts_agent ON agent_personality_facts(agent_id, category);

-- ───────────────────────────────────────────────────────────
-- agent_preferences — mutable preference signals with strength
-- Example: {agent: 'coder', key: 'indent_style', value: 'spaces',
--           signal_strength: 0.9, signal_type: 'liked'}
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  key TEXT NOT NULL,                -- short identifier: 'mail_tone', 'sleep_time'
  value TEXT,                       -- the preferred value
  signal_strength REAL DEFAULT 0.0, -- -1.0 (strong dislike) to +1.0 (strong like)
  signal_type TEXT DEFAULT 'neutral', -- liked | disliked | neutral | boundary
  source_chunk_id INTEGER,
  metadata TEXT,                    -- JSON free-form
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_prefs_agent_key ON agent_preferences(agent_id, key);
CREATE INDEX IF NOT EXISTS idx_prefs_agent_type ON agent_preferences(agent_id, signal_type);

-- ───────────────────────────────────────────────────────────
-- agent_preference_relations — junction: which agents a preference is about
-- Absence of rows = standalone preference (no target).
-- One row per target_agent = single-target preference.
-- N rows = multi-target preference ("warm with peers" → A, B, C).
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_preference_relations (
  preference_id INTEGER NOT NULL REFERENCES agent_preferences(id) ON DELETE CASCADE,
  object_agent_id TEXT NOT NULL REFERENCES agents(id),
  PRIMARY KEY (preference_id, object_agent_id)
);
CREATE INDEX IF NOT EXISTS idx_pref_rel_object ON agent_preference_relations(object_agent_id);

-- ───────────────────────────────────────────────────────────
-- preference_review_queue — SessionEnd enqueues; agents dequeue
-- When a session ends, a marker is inserted. The next in-session agent
-- can call preferences_pending() to get the queue, pull session chunks
-- via memory_search, consolidate in its own context, write results via
-- preferences_write. On success, the agent calls preferences_consolidate_complete
-- to remove the marker.
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS preference_review_queue (
  session_id TEXT PRIMARY KEY,
  agent_id TEXT,                    -- which agent owned the session (nullable)
  chunk_count INTEGER,              -- how many chunks were in the session
  enqueued_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  claimed_at INTEGER,               -- non-null when an agent starts consolidation
  claimed_by TEXT                   -- agent_id that claimed (prevents double-work)
);
CREATE INDEX IF NOT EXISTS idx_pref_queue_unclaimed ON preference_review_queue(claimed_at, enqueued_at);

-- ───────────────────────────────────────────────────────────
-- Seed agents from built-in personality templates
-- Users can add/rename/remove later. Metadata column holds per-install
-- display data without polluting the core schema.
-- ───────────────────────────────────────────────────────────
INSERT OR IGNORE INTO agents (id, name, role) VALUES
  ('coder',      'Coder',      'coder'),
  ('architect',  'Architect',  'architect'),
  ('reviewer',   'Reviewer',   'reviewer'),
  ('writer',     'Writer',     'writer'),
  ('researcher', 'Researcher', 'researcher'),
  ('confidant',  'Confidant',  'confidant');

COMMIT;
