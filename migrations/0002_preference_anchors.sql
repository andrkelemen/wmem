-- 0002_preference_anchors.sql
--
-- Evidence for preferences. A preference is an assertion; anchors are the
-- chunks of conversation that formed, reinforced, contradicted, or refined it.
-- Many-to-many — one preference can accumulate anchors across sessions; one
-- chunk can anchor multiple preferences.
--
-- Valence, not delete: contradicting evidence doesn't remove a preference,
-- it refines it. Tier-3 consolidation reads the valence distribution to
-- decide whether to promote, demote, or split a preference.

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS preference_anchors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preference_id INTEGER NOT NULL REFERENCES agent_preferences(id) ON DELETE CASCADE,
  chunk_id INTEGER REFERENCES chunks(id),
  valence TEXT NOT NULL CHECK (valence IN ('reinforces', 'contradicts', 'refines')),
  annotation TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_anchors_pref
  ON preference_anchors(preference_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_anchors_chunk
  ON preference_anchors(chunk_id);

COMMIT;
