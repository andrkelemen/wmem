# Changelog

All notable changes to wmem are documented here. Format loosely based on
[Keep a Changelog](https://keepachangelog.com/).

## [1.2.0] — 2026-05-17

### Added

- **Multi-instance safety: `wmem_role` table + role gate middleware** — when
  more than one wmem runs (one canonical master + N read-only mirrors), only
  the master accepts writes. Mirrors refuse with `403 wmem_role_not_master`
  so misrouted writes surface immediately instead of silently forking the
  dataset. Migration `0010_wmem_role.sql` adds the table; `server.mjs` seeds
  the row at first boot (default `master` for single-user installs, override
  via `WMEM_ROLE=mirror|master`). Exposed at `GET /api/wmem/role`.
- **Generic write dispatcher: `POST /api/write`** — single endpoint that
  takes `{ op: "namespace.verb", args: {...} }` and routes to a server-side
  allowlist (`WRITE_DISPATCH`). 22 ops covered: `memory.{amend,share,personal}`,
  `project.{upsert,ship,scope.upsert,scope.path.upsert}`, `session.file.touch`,
  `personality.{upsert,delete,enable,sfw,activate,file.set}`,
  `personality.core.{add,update,delete}`,
  `personality.trait.{add,update,enable,disable,delete,promote}`. Unknown ops
  return `404` with the full `known_ops` list. All ops go through the
  isMaster gate.
- **`modules/wmem-outbox/` — local proxy daemon** for offline-tolerant
  writes. Sits at `localhost:18421`, forwards requests to upstream wmem
  master, buffers to local SQLite when master unreachable (5xx or transport
  failure), drains on reconnect with exponential backoff + dead-letter after
  12 retries. Idempotent against server-side dedup (200 `deduped:true` or
  409 collapses to delete). Reserved admin endpoints: `/health`, `/role`,
  `/admin/drain`, `/admin/outbox`, `/admin/outbox/dead-letter`. systemd-user
  install script included.
- **New `core/personalities.mjs`** (id-keyed v2 module) alongside legacy
  `core/personality.mjs` (name-keyed). Powers the new dispatcher ops.
- **Migrations 0006-0010** — `personality_rename`, `drop_legacy_agent_aliases`,
  `personality_core_traits`, `personality_switch_audit`, `wmem_role`.

### Changed

- `server.mjs` now boots with role-seeding (`master` by default), role-gate
  middleware, and the `/api/write` dispatcher in front of the existing
  endpoint surface. Existing endpoints (`/api/ingest`, `/api/mail/*`, etc.)
  unchanged behaviorally — they just also go through the role gate now.

### Topology

The new pieces are the multi-instance moat. Library-mode users (single local
SQLite) get a transparent default: `master` is auto-stamped, writes work as
before, the dispatcher is just additional surface. Multi-instance operators
get a real shape: stamp one box as `master`, all others as `mirror`, each
non-master runs `wmem-outbox` against the master, MCP clients point at
their local `:18421` and never have to think about upstream availability.

### Refs

Backported from an internal fork after a forked-write incident ran for ~3
weeks across three boxes. The role gate + outbox pattern are the
lessons-learned. See `modules/wmem-outbox/README.md` and migration
`0010_wmem_role.sql` for the architectural background.

## [1.1.0] — 2026-04-19

### Added

- **Inter-agent mail** — `/api/mail/*` HTTP routes + 10 `mail_*` MCP tools
  for agent-to-agent messaging. Pull-based delivery (cheap `mail_pending`
  probe + conditional `mail_inbox` fetch). Threaded replies, read-state
  mutation, cross-agent counts. Consumer-side integration contract is
  encoded as runnable test stages in `tests/mail-mcp.test.mjs`
  (`sv-poll-pattern-*`).
- **Capability registry** — new `capabilities` table + FTS5 virtual
  mirror + 8 `capability_*` MCP tools for per-agent capability registration
  (tools, services, hardware, skills) and multi-agent workload routing
  queries (`capability_lookup`, `capability_match`).
- **Runtime identity switching** — `agent_switch(agent_id)` +
  `agent_current()` MCP tools let an admin session change the caller
  identity used by subsequent writes without restarting the process.
  Extracted into `core/session-identity.mjs` so tests exercise state +
  admin gating directly.
- **Bearer token auth** on write endpoints — `POST /api/ingest`,
  `/api/mail/send`, `/api/mail/reply/:id`, `/api/mail/read/:id`,
  `/api/mail/unread/:id` now require `Authorization: Bearer <token>`
  when `WMEM_TOKEN_FILE` is set. Timing-safe compare via
  `crypto.timingSafeEqual`. Soft-fails to no-auth when the token file is
  absent (dev-friendly default).
- **Caller-identity attribution** — HTTP `X-Caller` header ↔ MCP
  `WMEM_CALLER` env stamp `from_agent` on messages and `written_by` on
  chunks/preferences/facts/anchors. NULL attribution is the graceful
  degraded default.
- **Admin-gated `args.agent` override** — MCP tools that accept an
  `agent` argument (capability_add, mail_inbox, etc.) now require
  `WMEM_ADMIN=1` env when that argument is used. Non-admin sessions
  cannot impersonate other agents via the tool boundary.

### Changed

- `mail_read` / `mail_unread` MCP tools now return
  `{ ok: true, changed: bool, id }` — `ok` reports request validity,
  `changed` reflects state mutation. Idempotent second-call returns
  `ok: true, changed: false` (REST-style semantics).
- Default token path for bearer auth is `./.wmem-token` (env-overridable
  via `WMEM_TOKEN_FILE`) — cwd-relative so npm-install-and-run users can
  drop a token next to their install.
- README + `docs/architecture.md` + `docs/mcp-tools.md` tool-count
  references updated from 48 → 69 to reflect the added surface.

### Security

- Bearer token auth with timing-safe comparison on write endpoints.
- Admin gate on `args.agent` override closes an impersonation vector in
  MCP tool handlers.
- `.wmem-token` added to `.gitignore` — token files must never enter a
  commit.

### Positioning

wmem now has two clear deployment modes:

- **As library** (single-user, zero-infra): stdio MCP, one agent, local
  SQLite, no HTTP. `npm install && npm start`.
- **As service** (multi-agent): `node server.mjs` HTTP API with
  bearer-auth-gated writes, `WMEM_ADMIN=1` operator sessions can use
  `agent_switch` for routed flows. Shared DB across multiple MCP clients.

One codebase, two deployment patterns. Library-mode users can ignore
`mail_*` + `capability_*` + `agent_*` entirely; service-mode users
layer them on.

## [1.0.0] — 2026-04-10

Initial public release. Memory substrate for AI agents with SQLite +
FTS5 keyword search, hybrid vector retrieval (optional), MCP tool
surface (48 tools), personality files, project scopes, session-file
tracking, preference + facts pipelines, knowledge-graph relations.
