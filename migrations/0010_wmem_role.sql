-- 0011 — wmem_role: identifies this wmem instance as canonical/master vs mirror.
--
-- Background: before the multi-instance gate, three boxes ran independent writable wmem
-- services. Forked memory accumulated for ~3 weeks. Recovery merged the
-- forks back into master canonical (wmem multi-instance recovery). To prevent recurrence, every
-- wmem instance now stamps its own role at first boot:
--
--   master  — THIS instance is canonical. Writes accepted. Only master (your-master-host).
--   mirror  — read-only copy of canonical. Writes REFUSED at handler level.
--   unknown — uninitialized. Refuse writes, log loudly, surface in /api/health.
--
-- Clients (MCP, scripts, watchers) MUST check /api/wmem/role before
-- writing. Refuse-to-write if role != 'master'. This is the architectural
-- gate that "you're supposed to write to canonical" was missing before.
--
-- Set at boot via mcp-server/server.mjs startup logic, NOT here. This
-- migration only creates the table. Role assignment is environment-dependent
-- (hostname check + WMEM_ROLE env override).

CREATE TABLE IF NOT EXISTS wmem_role (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  role TEXT NOT NULL CHECK (role IN ('master', 'mirror', 'unknown')),
  hostname TEXT,
  set_at INTEGER NOT NULL,
  set_by TEXT,                            -- env, hostname-detect, manual
  notes TEXT
);

-- No INSERT here — the running service inserts at startup based on
-- hostname or WMEM_ROLE env. Default for new instances is 'unknown',
-- which fails-closed (refuses writes) until explicitly set.
