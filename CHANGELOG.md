# Changelog

All notable changes to wmem are documented here. Format loosely based on
[Keep a Changelog](https://keepachangelog.com/).

## [1.4.0] — 2026-10-27 — the release where `npx wmem init` becomes true

The README has said `npx wmem init` since v1.3a. **wmem has never been published to npm**,
so that command has never worked for anyone — on the release whose entire thesis was
download-and-run. This is the release that makes the sentence true, and everything in it
was found by actually doing it: `npm pack`, install the tarball into an empty directory
with an empty HOME, and watch.

### Fixed
- **Dependency detection asked the wrong question.** Step 3 checked whether
  `WMEM_ROOT/node_modules/better-sqlite3` exists — true only for a git clone. Installed
  from npm, node hoists dependencies to the *parent* `node_modules`, so the check failed
  and setup ran `npm install --production` inside `node_modules/wmem`, installing into a
  directory the host package manager owns. It now asks whether the module *resolves*,
  which is the actual question.
- **`--dry-run` wrote to disk.** On a machine with no wmem yet it left a real database
  behind — WAL and SHM included — and printed "nothing was changed". Two unguarded calls:
  a personality lookup in step 7 and the verification block in step 10. Reading opens the
  database and opening it creates it, so on a fresh machine a read is a write.
- **A clean first install reported failure.** Success was `stats.total > 0`, so a new
  machine with no CLAUDE.md and no prior sessions — the exact state of a first install —
  finished with *"setup finished with warnings — check above"*, where the warnings above
  were "no CLAUDE.md found" and "no sessions directory". Nothing was wrong. An empty store
  on day one is the correct outcome; it now says so.
- **"Next steps" printed commands the reader cannot run.** `node scripts/personality.mjs …`
  is runnable from a git clone only; installed from npm those files are inside
  `node_modules`. Now absolute, and the hook check is `wmem doctor --hooks`. Same defect as
  the reimport usage lines in 1.3.3 — advice that works on the author's machine is not
  advice.

### Added
- **`license`, `repository`, `homepage` and `bugs` in `package.json`.** Without `license`
  the registry page reads UNLICENSED regardless of the LICENSE file sitting beside it.
- `tests/setup-dry-run.test.mjs` — asserts a dry run creates no database, no rc file and
  nothing in the working directory. It pins the target with `--db`, because without that
  the resolver finds the repo's own populated store and the check passes against broken
  code: the first version of this test did exactly that. Both guards verified red
  independently.

### Verified, not assumed
`npm pack` → install the tarball into a clean directory → `wmem init` against an empty
HOME → `wmem doctor --status` reads the same store the install created, resolved through
the `~/.wmemrc` setup wrote. The database lands in `~/.wmem/memory.db` and not inside
`node_modules`, which is what the 1.3.1 split fix was for and this is the first time it has
been proven on a real install.

### Still your call
`npm publish` itself. The package is ready — `wmem` is unclaimed on the registry — but
publishing needs an `npm login` that only you can do.

## [1.3.3] — 2026-10-27 — documentation that recreated the bug

#41. The split database was fixed in code and left standing in the usage text.

### Fixed
- **`scripts/reimport.mjs` no longer tells you to pin `MEMORY_DB` to a cwd-relative path.**
  Four usage lines read `MEMORY_DB=./data/memory.db node scripts/reimport.mjs …`. Copied
  from any other directory they enrich a second, empty store and report success — the
  split database, reproduced by hand, from the documentation. Documentation that hands out
  a relative path is the same defect as code that defaults to one.
- **`mcp-server.mjs`'s header** no longer claims storage lives at `data/memory.db`; it
  names the resolver and its order.
- `core/doctor.mjs:457`, also listed in #41, was fixed in 1.3.2.

### Added
- **The repo now checks itself.** `tests/db-path.test.mjs` walks every `.mjs`, `.js`, `.md`
  and `.sh` file and fails if any carries a relative `data/memory.db`, in code *or* in a
  comment. The bug returned twice after the resolver landed — once as a live fallback, once
  as copy-paste usage text — and neither is something a reviewer reliably catches in a
  diff. Only `core/db-path.mjs` and this changelog may name the old path.

## [1.3.2] — 2026-10-27 — the rest of #37

Three findings from a Windows install of v1.3, reported in #37. The first is the tail of
the split database fixed in 1.3.1 — two sites that resolver did not reach.

### Fixed
- **`core/doctor.mjs` had its own `./data/memory.db` fallback**, so `wmem status` could
  report the size of a database it was not reading from. It now asks the open connection
  which file it holds. (Mine: the grep that found the other three defaults was capped at
  twenty lines and this was the twenty-first — a truncation that did not declare itself,
  in a week spent building a tool whose whole rule is that they must.)
- **`wmem doctor --status` lists every candidate database**, marks the open one, and shows
  what `MEMORY_DB` and `~/.wmemrc` each say. Both halves share a resolver now, so a
  divergence can only come from an explicit `MEMORY_DB` handed to one process and not the
  other — which is invisible from inside either of them.
- **`createPersonality` writes an `id`.** `personalities.id` is `TEXT PRIMARY KEY` after
  0006, and SQLite permits NULL in a non-INTEGER primary key, so every personality created
  this way landed with `id = NULL`: absent from `agents_list`, and rejected as the target
  of `personality_preferences`, `personality_facts` and the switch audit, all foreign keys
  onto that column. The symptom was `preferences_write` failing with "unknown agent" while
  `memory_ingest` accepted the same name, because `chunks.agent` is free text with no
  foreign key. Only the six built-ins worked, because 0001 seeds them with an id.
- **Existing NULL-id rows are repaired**, because fixing the writer does not fix the data
  and the people holding it are the ones the fix was for. A repair that would collide with
  an existing id is refused and named, never merged.
- **The stale `CREATE TABLE personalities` in `core/personality.mjs` is gone.** It declared
  `id INTEGER PRIMARY KEY AUTOINCREMENT`, a shape from before 0006. On a migrated database
  it never ran; on a bare one it would have created a table the migrations disagreed with.

### Changed
- **"The memory system is invisible to the user" is gone from all four places it appeared**
  — the L1 block, two places in the MCP server instructions, and the architecture doc.
  It told the model to hide where its information came from, which is a rule the model then
  has to either break or follow badly. Replaced: retrieval is an ordinary tool; do not
  narrate every lookup, but when the user asks how you know something, say it came from
  wmem.

### Added
- `tests/personality-id.test.mjs` — creates a personality and then *writes a preference
  against it*, because "it was created" was never the question a user is asking. Plus the
  repair, the refused collision, and the run-once stamp. Verified red against the old insert.

## [1.3.1] — 2026-10-27 — the split database

Reported by a user the morning after v1.3 shipped. On a default install the hooks wrote
every session into one database and every MCP tool read another, so `memory_search` could
never find what the hooks had just saved. **Nothing errored**, which is how it survived a
release: a split store is not a crash, it is a silence.

### Fixed
- **One resolver decides where the database is** (`core/db-path.mjs`), imported by
  `core/db.mjs`, the migration runner and the hooks. There were three different defaults
  for an unset `MEMORY_DB` — `./data/memory.db` in core, the same relative path in the
  migration runner, and `~/.wmem/memory.db` in the hooks — and `setup.mjs` registered the
  MCP server with `MEMORY_DB=<install>/data/memory.db` baked into the command while
  registering the hooks with no environment at all.
- **`setup.mjs` writes `MEMORY_DB` into `~/.wmemrc`.** `loadRc()` has always read that
  file and would have reconciled all of it, but nothing ever wrote it — the read side
  shipped and the write side did not, the same shape as #17. The MCP server now reads the
  rc file too, since it is the only channel that reaches a process nobody passed an
  environment to.
- **No more cwd-relative defaults.** A relative default is how you silently get a fresh
  empty database every time you change directory; `node migrations/_runner.mjs` from the
  wrong folder migrated a brand-new file and exited 0. The runner now prints the database
  it is about to touch.
- **The database no longer lives in the install directory.** A fresh install uses
  `~/.wmem/memory.db`, because `WMEM_ROOT` can be an npx cache or a `node_modules` folder
  that a reinstall deletes. **Existing stores are not moved or orphaned**: a populated
  database in any previously-defaulted location is found and kept.
- **Two populated databases are reported, never silently chosen between.** Anyone already
  affected has sessions in both; an automatic pick would hide half of them, and an
  automatic merge of two divergent stores is unrecoverable. One warning, printed by the
  server, the hooks and setup alike.
- **`tests/agents.test.mjs` no longer asserts a hardcoded list of migration filenames.**
  It had been failing on `main` since v1.3 shipped, because migration 0011 is a code
  migration that stamps itself with a `.code` suffix — a test that restates the contents of
  a directory it does not read breaks on correct work. It now reads `migrations/` from disk.

### Added
- `tests/db-path.test.mjs` — including the assertion whose absence allowed all of this:
  that the hooks and the server resolve to the same file. Every case verified red against
  the pre-fix defaults.

### Upgrading
If sessions went missing after installing v1.3, they are not lost. Run `wmem doctor` — if
two databases hold data it will name both. Point `MEMORY_DB` at whichever you want to keep
and re-run `npx wmem init`; nothing is merged for you.

## [1.3.0-b] — 2026-10-26 — "v1.3b", documentation

The README described an install that no longer exists and a roadmap that was wrong in both
directions.

### Changed
- **Quick Start is one command.** It presented two paths as equals — "install the plugin,
  then clone the repo and run setup" beside "clone the repo and run setup" — which is one
  installer wearing two instructions. Now `npx wmem init`, with the plugin and the clone as
  variations beneath it, and `wmem doctor --hooks` as the step that follows, because hooks
  only fire on the *next* session and "registered" is not "fired".
- **The CLI is documented.** `wmem`, `wmem init`, `wmem doctor`, `wmem hooks`, `wmem help`
  existed as of v1.3a and appeared nowhere.
- **Cross-platform is stated plainly.** The hooks are node rather than shell, so Windows
  works; previously they were bash files that shelled out to python3 and silently did
  nothing there.
- **Roadmap de-staled.** It still listed as pending: hook auto-registration, hook-based
  bookmarking, KG materialization, and `--secrets` — all shipped. It listed nothing found
  since. Independent-agents-on-one-instance is now on it with the honest blocker written
  down: per-request identity exists on the HTTP path and reads route over it, but writes go
  direct to SQLite in-process, and the HTTP path trusts `X-Caller` without checking it
  against the env anchor.
- **Multi-agent configuration is explained** where the env vars are: one `WMEM_CALLER` per
  MCP server entry, because stdio is process-per-connection so the variable *is* the session
  identity.

### Added
- **"Two behaviours that surprise people."** Dedup is a dry run by default, with the reason
  — the preview is what revealed that dedup grouped without `session_id` while `insertChunk`
  dedups with it, 96,258 false positives on a live store. And `memory_last_session` returns
  rulings above the tail, with the tail labelled, and an empty list that says so when a
  session banked nothing.

## [1.3.0-a] — 2026-10-26 — "v1.3a", the install release

Download and run. One command from nothing to a working install, and the install tells the
truth about itself afterwards.

### Fixed
- #19 — the hooks are **node, not bash**. They were `.sh` files using bash-only constructs
  and shelling out to `python3` for JSON; on a Windows host neither is reliably present, so
  none of them ran. Node is already a hard dependency, which makes it the one interpreter
  guaranteed to exist wherever wmem works at all. Replacing the shell also removed a second
  JSON-escaping implementation (a python3 pipeline with a sed+awk fallback behind it) whose
  choice of path depended on the host.
- #16 — `SessionEnd` is registered, and with it the three things that had never run once:
  the incremental index, the preference-consolidation enqueue, and the session bookmark.
  The features were not missing, they were unreachable. `PostToolUse` is registered too; it
  shipped and was documented but was never in the installer's map.
- #20 — the server's instructions told the model to poll a queue that could not fill. With
  the hook reachable, the statement is true. `wmem doctor --hooks` is the check that makes
  it falsifiable.

### Added
- `wmem init` / `npx wmem init` — the one-command install, which **is** `scripts/setup.mjs`
  rather than a second path beside it. The first draft of this release added a new
  `init.mjs` that duplicated an installer already in the repo, and did the MCP registration
  worse: it printed a block to paste, while `setup.mjs` has always called
  `claude mcp add -s user`, which is the supported route and does not depend on guessing the
  shape of someone's settings file. Two installers is the same defect as two copies of a
  vocabulary — the duplicate is deleted.
- Setup's verification step now proves the native module **loads** rather than exists. Step
  3 checks for the `better-sqlite3` directory, which is present even when its prebuilt
  binary was built for a different node ABI; in that case `require()` throws and later steps
  fail far from the cause. Opening the database is also what applies migrations, so one call
  proves both and names the real fix (`npm rebuild better-sqlite3`) when it cannot.
- `wmem doctor --hooks` — **the canary.** Every hook stamps a file when it fires, so
  "registered" and "last fired" are reported separately. *Registered and never fired* is a
  real state, it is the state #16 was in, and it used to be invisible: an empty preference
  queue looks exactly like a quiet one.
- `wmem help`, and subcommand dispatch (`init`, `doctor`, `hooks`) that runs **before** any
  import touches the database — an init command that needs a working install to start is
  not an init command.

### Changed
- `register-hooks` **verifies instead of reporting.** It re-reads the file it just wrote and
  prints what is actually in there. It also recognises the old `.sh` entries and replaces
  them, so upgrading does not leave two hooks on one event, and it preserves other tools'
  hooks through both install and uninstall. Commands are quoted on both halves, because the
  node path contains "Program Files" more often than not.
- `package.json` gained a `files` whitelist, so a publish ships the library and not the
  working tree.

### Note on the version string
`1.3a` is not valid semver, so npm cannot publish it as written. Published as a prerelease
it would be `1.3.0-a.1`, and users would then need `npx wmem@next` rather than `npx wmem` —
which works against the point of this release. `package.json` therefore stays at `1.3.0`
and this entry carries the label. Maintainer's call.

## [1.3.0] — 2026-10-26

Release bookkeeping caught up (#31). Nine PRs labelled v1.3 merged between 2026-05-17 and
2026-06-10 and none of the bookkeeping followed: package.json still read 1.2.0, the newest
changelog entry predated every v1.3 merge, the only tag in the repo was v1.1.0, and the
README already advertised the shipped work as v1.3+. A version number that disagrees with
the README is worse than an absent one, because it gets quoted.

### Added
- PR-A — SessionStart / SessionEnd hooks and the hook installer.
- PR-B — personality CLI, including the interactive switcher.
- PR-E — L1 cross-folder pick-up.
- PR-F — `wmem_doctor --secrets`, key-shape scanning over chunks.
- PR-H — Claude Code plugin packaging.
- PR-I — facet routing (`core/facets.mjs`).
- #84 — MCP reads route via `WMEM_HTTP_URL` when set.

### Fixed in this release
- #15 — `wmem_dedup` is a DRY RUN by default and requires `--force` at the CLI, matching
  `--purge-agent` and `--purge-personality`. And the grouping disagreed with the writer:
  it ignored `session_id` while `insertChunk` dedups on it deliberately, so it would have
  deleted exactly the rows the insert path preserves. Measured on a 380,000-chunk store:
  96,258 chunks across 40,122 groups, about a quarter of the database, every one a false
  positive.
- #14 — `wmem_status` reported `import_registry`'s page size as its count (`imports: 10`
  against 37 rows) and could never report more than ten stale.
- #13 — agent keys are canonicalised (trim + lower) at `insertChunk` and `upsertSession`.
  `resolveAgent` lower-cased the alias lookup and returned the raw input on fall-through,
  so an unusual spelling became a new agent and split one operator's history.
- #17 — `memory_last_session` returns the rulings a session deliberately banked, printed
  above the tail of execution, with the tail labelled as not-a-decision.
- #30 — `capabilities.md` no longer ships seven example lines describing someone's actual
  house into every clone's hot memory block.

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
