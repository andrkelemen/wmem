-- 0009 — personality switch audit log.
--
-- Every flip of `personalities.active = 1` writes a row here. Feeds the
-- /api/panel/audit endpoint + a future UI history pane. Separate table
-- (not metadata on personalities) because the row shape is append-only
-- event log — one row per state transition, never updated.
--
-- Fields:
--   from_personality  — id of the row active=1 BEFORE the switch (nullable
--                       on first boot / when no prior active)
--   to_personality    — id being activated (FK personalities.id)
--   caller            — who initiated the switch (from req.caller or MCP
--                       session-identity); nullable for system-triggered
--   reason            — free-form operator note ('scene-mode', 'testing
--                       sample voice'); nullable
--   ts                — unix ms timestamp
--
-- Not in phase 1 scope: retention policy. Table grows append-only; if
-- volume becomes a concern, add a retention job that archives to chunks.

BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS personality_switch_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_personality TEXT,
  to_personality   TEXT NOT NULL REFERENCES personalities(id),
  caller           TEXT,
  reason           TEXT,
  ts               INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_psa_ts ON personality_switch_audit(ts);
CREATE INDEX IF NOT EXISTS idx_psa_to ON personality_switch_audit(to_personality);

COMMIT;
