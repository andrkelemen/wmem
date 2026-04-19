# Changelog

All notable changes to wmem are documented here. Format loosely based on
[Keep a Changelog](https://keepachangelog.com/).

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
