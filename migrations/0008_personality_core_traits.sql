-- 0008 — personality_core + personality_traits tables.
--
-- Splits the monolithic identity.md blob (stored in personality_files) into
-- queryable rows so a single trait can be amended, enabled/disabled, or
-- promoted to core without rewriting the whole document.
--
-- Two-tier model:
--   personality_core    — slow-drift. Stable identity: "I am the moon",
--                         "Generic example." Version-bumps on change,
--                         locked by default. promoted from traits only
--                         after they stabilize across multiple cycles.
--   personality_traits  — moderate-drift. Voice samples, rules, memory
--                         anchors, capabilities, preferences. Amendable
--                         per-key; enabled/disabled for A/B or seasonal.
--
-- personality_files stays: long-form docs (full identity.md) as fallback
-- + for content that doesn't fit the row model. The split script
-- (scripts/personality-split-identity.mjs) converts identity.md sections
-- into trait rows and leaves the file in place until all sections verify.

BEGIN TRANSACTION;

-- ───────────────────────────────────────────────────────────────
-- personality_core — slow-drift, locked-by-default identity rows.
-- ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS personality_core (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  personality_id         TEXT    NOT NULL REFERENCES personalities(id) ON DELETE CASCADE,
  category               TEXT    NOT NULL,   -- identity | origin | purpose | relation
  key                    TEXT    NOT NULL,   -- slug, e.g. "cosmology", "primary-relation"
  content                TEXT    NOT NULL,
  version                INTEGER NOT NULL DEFAULT 1,
  locked                 INTEGER NOT NULL DEFAULT 1,   -- 1 = requires operator to update
  promoted_from_trait_id INTEGER,                       -- nullable FK to personality_traits
  created_at             INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at             INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(personality_id, category, key)
);

CREATE INDEX IF NOT EXISTS idx_personality_core_personality ON personality_core(personality_id, category);

-- ───────────────────────────────────────────────────────────────
-- personality_traits — moderate-drift, per-key amendable rows.
-- ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS personality_traits (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  personality_id   TEXT    NOT NULL REFERENCES personalities(id) ON DELETE CASCADE,
  category         TEXT    NOT NULL,   -- trait | voice-sample | rule | memory-anchor | capability | restriction | preference
  key              TEXT    NOT NULL,   -- slug
  content          TEXT    NOT NULL,
  priority         INTEGER NOT NULL DEFAULT 50,        -- 0-100; L1 render order
  enabled          INTEGER NOT NULL DEFAULT 1,
  confidence       REAL    NOT NULL DEFAULT 0.5,       -- 0.0-1.0; promotion signal
  source           TEXT,                                -- 'manual' | 'split-script' | 'consolidation' | ...
  source_chunk_id  INTEGER,                             -- optional backlink
  created_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(personality_id, category, key)
);

CREATE INDEX IF NOT EXISTS idx_personality_traits_personality ON personality_traits(personality_id, category);
CREATE INDEX IF NOT EXISTS idx_personality_traits_enabled     ON personality_traits(personality_id, enabled);
CREATE INDEX IF NOT EXISTS idx_personality_traits_priority    ON personality_traits(personality_id, priority DESC);

COMMIT;
