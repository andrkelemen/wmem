-- 001 — wmem-outbox initial schema
-- One-shot init; daemon applies on first boot.

CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      INTEGER NOT NULL,
  endpoint        TEXT    NOT NULL,
  method          TEXT    NOT NULL DEFAULT 'POST',
  headers_json    TEXT    NOT NULL DEFAULT '{}',
  payload         BLOB    NOT NULL,
  payload_type    TEXT    NOT NULL DEFAULT 'application/json',
  retry_count     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_attempt_at INTEGER,
  status          TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dead-letter'))
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_id     ON outbox(status, id);
CREATE INDEX IF NOT EXISTS idx_outbox_created_at    ON outbox(created_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
