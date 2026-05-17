-- 0007 — cleanup orphan table created by db.mjs lazy-init.
--
-- During the personality-rename cutover, 0006 renamed agent_aliases →
-- personality_aliases. But core/db.mjs still had 5 stale refs to the old
-- name (CREATE IF NOT EXISTS + 4 query sites). On post-migration wmem
-- boots, getDb() ran those queries and lazy-created a SECOND empty table
-- called `agent_aliases`, splitting any future alias writes from the
-- canonical personality_aliases that doctor.mjs / aliases lookups now read.
--
-- core/db.mjs fixed in same commit as this migration. This cleanup drops
-- the orphan table. Safe because the canonical master cutover verified both
-- tables empty at verify-time.

BEGIN TRANSACTION;

DROP TABLE IF EXISTS agent_aliases;

COMMIT;
