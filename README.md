# wmem

> Memory + identity + judgment for AI agents. One SQLite file. Zero API cost.

Runs **two ways**:

- **As a personal MCP companion** (single-user, zero-infra): stdio MCP, one
  agent, local SQLite. `npm install && npm start`.
- **As a multi-agent memory service**: `node server.mjs` exposes an HTTP
  API with optional bearer-token auth on writes, shared DB across MCP
  clients, agent-to-agent mail, capability registry, runtime identity
  switching for operator sessions.

One codebase, two deployment patterns. Library-mode users can ignore the
service-mode tools entirely (the `mail_*`, `capability_*`, `agent_*` MCP
surface).

## Quick Start

```bash
git clone https://github.com/andrkelemen/wmem.git
cd wmem
node scripts/setup.mjs --agent myname
```

That's it. The setup script handles everything: npm install, import your CLAUDE.md, index your sessions, create a personality, register the MCP server via `claude mcp add`.

Preview first with `--dry-run`:
```bash
node scripts/setup.mjs --agent myname --dry-run
```

## Why

AI agents forget. Every compaction, every restart — knowledge is lost. wmem fixes this with a layered memory system, hybrid search, and three features nobody else has:

1. **Personality switching** — change who the agent IS, not just what it remembers
2. **Proactive behavior** — AI that knows when to speak and when to shut up
3. **Knowledge graph** — relationships emerge from data, no graph database needed

## Features

### One-Command Setup
```bash
node scripts/setup.mjs --agent myname
```
Detects OS, installs deps, imports existing files, indexes sessions, creates personality, registers MCP server. Linux, macOS, Windows.

### Hybrid Search (FTS5 + Vector + Session Dedupe)
Multi-stage retrieval in one SQLite file. `memory_search` auto-routes based on what's in the DB — hybrid when vectors exist, tag-boosted FTS5 otherwise.

- **FTS5 keyword search** — exact match, <10ms, zero cost
- **Tag boost** — chunks whose auto-tags match query-derived tags rank higher (always on, no flag)
- **Query expansion** — 200+ synonym mappings, zero LLM
- **sqlite-vec semantic search** — local bge-large (1024d) or MiniLM (384d) embeddings (pre-1.0 at `^0.1.9` — fine for personal-scale; flag before broader deployment)
- **Hybrid mode** — position-normalized merge of BM25 + cosine similarity, plus 2x boost for user-message chunks
- **Session dedupe** — top-K returns K distinct sessions, not K chunks (better coverage for multi-session and temporal questions)
- **Cross-encoder reranker** — ms-marco-MiniLM-L-6-v2 (22MB), available in `scripts/benchmark-experimental.mjs` for offline runs; off in the interactive MCP path
- **Sub-query splitting** — "how many days between X and Y" → search X and Y independently

Benchmark scripts are in `scripts/` for anyone who wants to measure on their own workloads.

### Personality Switcher
Switch who the agent IS. Each personality has its own memories, voice, capabilities, and decision thresholds.

```bash
node scripts/personality.mjs create dev --template coder
node scripts/personality.mjs create planner --template architect
node scripts/personality.mjs use dev        # instant switch
```

Built-in templates: **coder**, **architect**, **reviewer**, **writer**, **researcher**, **confidant**.

Export/import as JSON. Share personalities between machines.

### Proactive Personalities (Decision Engine)
Deterministic silence decisions. Asking an LLM whether to speak makes the model the judge of its own output — the decision and the output get coupled. Move the decision into a state machine with auditable thresholds instead. Don't ask the model. Build a state machine.

Four output modes:
- **SILENCE** — do nothing (default, most common)
- **NOTIFY** — logged, searchable, not pushed. "Worth remembering but not worth saying."
- **SPEAK** — deliver via preferred channel
- **ACT** — execute action without speaking

Each personality defines its own thresholds:
```json
{
  "decision": {
    "actionThreshold": 0.6,
    "cooldownMinutes": 15,
    "quietHours": [1, 7],
    "salienceModifiers": { "error": 1.3, "task_failed": 1.5 },
    "responseStyle": { "maxWords": 10, "register": "technical" }
  }
}
```

Same event, different personality, different behavior. Coder stays silent during focus. Researcher proactively shares findings. Writer barely speaks at all.

### Knowledge Graph
Relationships emerge from co-occurrence. No graph database.

```bash
# "What relates to authentication?"
graph_related → direct tag matches + co-occurring chunks from same sessions

# "What topics appear alongside auth?"
graph_topics → deployment (63 sessions), config (68), api (64)

# "How does auth relate to deployment?"
graph_path → strong (10 shared sessions), connecting chunks shown
```

Four node types: **topic**, **directory**, **project**, **agent**. Unified `kg_relations` table with typed edges. Directories auto-detect project from git remote. Related directories discovered by shared project, tag overlap (3+), or time proximity (24h).

Pure SQLite queries over existing tags + sessions tables. <50ms.

### Shared Memory + Privacy
Cross-personality shared memory with privacy controls.

- **`_shared`** — all personalities see it (projects, decisions, facts)
- **`private`** — only this personality (conversations, session history)
- **`personal`** — locked, cannot be shared. Ever.

`memory_share` copies to shared. `memory_personal` locks permanently.

### Universal Importer
Import whatever you already have. No reformatting.

```bash
# Dry run — preview sections + classifications
node scripts/setup.mjs --agent myname --dry-run

# Handles: markdown (.md), plain text (.txt), CLAUDE.md section splitting
# Classifies: personality vs memory vs config (with confidence scores)
# Low confidence → flagged for review, not guessed
# Atomic: whole file imports or none (SQLite transaction)
# Source tracing: file + section + line number in metadata
```

### Auto-Tags
25 topic + action patterns, generated on insert. No manual organization.

Tags: `auth`, `debugging`, `deployment`, `decision`, `fix`, `shipped`, `api`, `database`, `performance`, `security`, `frontend`, `testing`, `config`, `networking`, `automation`, `observability`, and more.

### Session-Aware Indexing
- **Incremental** — byte-offset tracking, only reads new content
- **Session-partitioned** — query by session or across all
- **Crash-safe** — validates trailing lines before advancing offset

### L1 Hot Memory Block
Auto-generated context loaded on every session start. Zero API cost.

```
TEMPORAL ANCHOR: Today, agent age
PERSONALITY: System prompt + voice + always-load files
CAPABILITIES: Manually maintained list
RECENT SESSIONS: Time-windowed compression (2h/6h/18h)
PROJECTS: Active/shipped/blocked state
```

~1,200 tokens. >95% of context window stays free.

### Personality Files
Named documents per personality (identity notes, preferences, style guides). Stored in DB, travel with personality on export.

Mark as `always_load: true` → injected into L1 every session.

### Multi-Instance Safety (v1.2)
Run one canonical master + N read-only mirrors without forking the dataset.

- **Role gate** — every wmem instance stamps itself `master` / `mirror` / `unknown` at first boot (default `master` for single-user; override `WMEM_ROLE=mirror` on follower boxes). Non-master writes get `403 wmem_role_not_master`.
- **`/api/wmem/role`** — clients check before writing; surfaces hostname + set-by metadata.
- **`POST /api/write` dispatcher** — single endpoint covering 22 admin ops (projects, sessions, personality core/traits, memory share). One server-side allowlist, one gate, no per-op route sprawl.
- **`wmem-outbox` daemon** — local proxy at `:18421`. MCP/scripts post writes to it instead of straight upstream. Forwards while master reachable, buffers to local SQLite when not, drains on reconnect with exponential backoff + dead-letter. Survives upstream outages without losing writes.

Library-mode users see no change — `master` is auto-stamped, writes work as before. Multi-instance topologies opt in by setting `WMEM_ROLE=mirror` on followers and running `modules/wmem-outbox/install/install.sh` on each.

See `modules/wmem-outbox/README.md` and `migrations/0010_wmem_role.sql`.

## Configuration

### Ports

| What | Default | Set via |
|------|---------|---------|
| HTTP server (`node server.mjs`) | `18420` | `PORT=` env, or `port` in `wmem.config.json` |
| Outbox daemon listen | `18421` | `WMEM_OUTBOX_PORT=` env, or `outboxPort` in `wmem.config.json` |
| Outbox → upstream | `127.0.0.1:18420` | `WMEM_UPSTREAM_HOST=` + `WMEM_UPSTREAM_PORT=` env, or `upstreamHost` + `upstreamPort` in config |

Defaults sit at `18420/18421` to avoid collision with Angular CLI (`4200`), Vite (`5173`), and other common dev ports.

**Interactive port picker** — probes candidates, prompts if taken, writes `wmem.config.json`:

```bash
node scripts/configure-ports.mjs                 # interactive: probe + prompt
node scripts/configure-ports.mjs --port 19420    # non-interactive
node scripts/configure-ports.mjs --print         # show resolved config
```

`wmem.config.json` is gitignored (per-machine). `wmem.config.example.json` ships as the template. Env vars always win over the file, which always wins over the default.

### Other env vars

| Var | Purpose | Default |
|-----|---------|---------|
| `MEMORY_DB` | SQLite DB path | `./data/memory.db` |
| `WMEM_TOKEN_FILE` | Bearer-auth token file path | `./.wmem-token` (auth disabled if file missing) |
| `WMEM_ROLE` | Force role `master`/`mirror`/`unknown` at boot | auto-detect → `master` for single-user |
| `WMEM_OUTBOX_*` | Outbox tuning (tick, batch, backoff, dead-letter) | see `modules/wmem-outbox/README.md` |

## Architecture

```
wmem/
├── core/
│   ├── db.mjs              ← SQLite + FTS5 + sqlite-vec + tags + sessions + aliases + privacy + kg_relations
│   ├── indexer.mjs          ← incremental JSONL indexer + auto-agent detection
│   ├── importer.mjs         ← universal file importer (markdown, text, CLAUDE.md)
│   ├── context.mjs          ← L-tier classification + validation + compression
│   ├── embeddings.mjs       ← local embeddings (transformers.js, all-MiniLM-L6-v2)
│   ├── autotag.mjs          ← pattern-based auto-tagging (40+ categories)
│   ├── personality.mjs      ← personality CRUD, files, activation, L1 integration
│   ├── decision.mjs         ← proactive behavior engine (salience + thresholds)
│   ├── graph.mjs            ← knowledge graph (topic/directory/project/agent nodes)
│   ├── expander.mjs         ← query expansion (200+ synonym mappings, zero LLM)
│   ├── facts.mjs            ← regex-based fact extraction (25+ patterns)
│   ├── temporal.mjs         ← date resolver (yesterday, last tuesday, N days ago)
│   ├── subquery.mjs         ← sub-query splitting for multi-event temporal
│   └── doctor.mjs           ← integrity checks, recovery, purge, checkpoints
├── scripts/
│   ├── setup.mjs            ← one-command setup (9 steps, cross-platform)
│   ├── index-sessions.mjs   ← CLI: indexing + --auto-agent + --merge aliases
│   ├── generate-l1.mjs      ← CLI: generate L1 hot memory block
│   ├── personality.mjs      ← CLI: create, use, list, show, export, import
│   ├── doctor.mjs           ← CLI: status, health check, fix, dedup, purge, recover
│   ├── import.mjs           ← CLI: import external files with tier placement
│   ├── session-start-hook.sh ← Claude Code hook: index + L1 + personality
│   └── session-end-hook.sh  ← Claude Code hook: index new content
│   ├── benchmark-ingest.mjs  ← ingest LongMemEval into wmem DB
│   └── benchmark-retrieval.mjs ← benchmark retrieval (keyword/expanded/hybrid/full)
├── mcp-server.mjs           <- MCP server (69 stdio tools)
├── server.mjs               <- HTTP service (read endpoints + 22-op /api/write dispatcher, v1.2)
├── modules/wmem-outbox/     <- local proxy daemon for multi-instance topologies (v1.2)
├── server.mjs               ← HTTP API server (Express, optional)
├── capabilities.md          ← what the agent can do (manually maintained)
├── LICENSE                  ← MIT
└── data/                    ← SQLite DB (gitignored)
```

## Tools

wmem exposes 69 stdio MCP tools (library mode) and an additional HTTP surface
when running `server.mjs` (service mode, v1.2+):

- **69 stdio MCP tools** — full inventory below, organised by domain
- **HTTP read endpoints** — `/api/search`, `/api/recent`, `/api/stats`, `/api/mail/*`, `/api/wmem/role`, `/health`
- **HTTP write endpoints** — `/api/ingest`, `/api/amend`, `/api/import`, `/api/reimport`, `/api/preferences/write`, `/api/facts/write`, `/api/capabilities/*`, `/api/mail/send`
- **HTTP dispatcher `/api/write` (22 ops, v1.2)** — `memory.{amend,share,personal}`, `project.{upsert,ship,scope.*}`, `session.file.touch`, `personality.{upsert,delete,enable,sfw,activate,file.set}`, `personality.core.{add,update,delete}`, `personality.trait.{add,update,enable,disable,delete,promote}`
- **Outbox admin** (when running `modules/wmem-outbox/`) — `/health`, `/role`, `/admin/{drain,outbox,outbox/dead-letter}`

All write endpoints are gated by the role middleware (refuses 403 on non-master instances). See [docs/mcp-tools.md](./docs/mcp-tools.md) for the full HTTP surface.

### MCP stdio tools (69)

| Tool | Description |
|------|-------------|
| **Memory** | |
| `memory_search` | FTS5 keyword search (scope: default/private/shared/all, snippet previews) |
| `memory_ingest` | Store content manually |
| `memory_l1` | Generate L1 hot memory block |
| `memory_capabilities` | Return capabilities list |
| `memory_recent` | Recent chunks by agent |
| `memory_stats` | Index statistics |
| `memory_share` | Share a chunk across all personalities |
| `memory_personal` | Lock a chunk to this personality (cannot be shared) |
| `memory_import` | Import a file or raw text (section splitting, auto-tags, source tracing) |
| `memory_delete` | Delete a chunk (preview first, confirm to execute) |
| `memory_last_session` | Where did we leave off? Current dir + parallel work across directories |
| `memory_sessions` | List recent session bookmarks by project/agent |
| **Projects** | |
| `project_update` | Create/update project state |
| `project_ship` | Mark project as shipped |
| `project_list` | List projects by status |
| **Personality** | |
| `personality_use` | Switch active personality (atomic, with checkpoint) |
| `personality_list` | List all personalities |
| `personality_create` | Create new (with templates + decision config) |
| `personality_show` | Show personality details |
| `personality_file_set` | Create/update personality file |
| `personality_file_list` | List personality files |
| **Knowledge Graph** | |
| `graph_related` | Find chunks related to a topic |
| `graph_topics` | Find co-occurring topics |
| `graph_path` | Relationship between two topics |
| `graph_map` | Full topic graph (nodes + edges) |
| **System** | |
| `wmem_status` | Full status report (chunks, sessions, agents, DB size) |
| `wmem_doctor` | Integrity checks (orphans, duplicates, stale sessions) |
| `wmem_dedup` | Remove duplicate chunks |

## What's Shipped

- [x] One-command setup (`node scripts/setup.mjs --agent myname`)
- [x] MCP server with 69 tools, registered via `claude mcp add`
- [x] Hybrid search (FTS5 keyword + sqlite-vec semantic + cross-encoder reranker)
- [x] Query expansion (200+ synonym mappings, zero LLM)
- [x] Cross-encoder reranker (ms-marco-MiniLM-L-6-v2, 22MB local model)
- [x] Sub-query splitting for multi-event temporal questions
- [x] Fact extraction (25+ regex patterns: name, age, location, etc.)
- [x] Temporal date resolver (yesterday, last tuesday, N days ago)
- [x] FTS5 snippet previews (match-anchored with `>>>markers<<<`)
- [x] FTS5 auto-OR for multi-word queries
- [x] Personality switching with 6 built-in templates + decision config
- [x] Personality files (named docs, always-load option)
- [x] Shared memory + privacy controls (private/shared/personal)
- [x] Proactive behavior engine (salience scoring, 4 output modes)
- [x] Knowledge graph (co-occurrence, 4 graph tools)
- [x] Universal importer (markdown section parsing, classification, atomic)
- [x] Manual document import CLI + MCP tool (`scripts/import.mjs`)
- [x] Session-aware incremental indexing (byte-offset, streaming 8MB chunks)
- [x] Auto-agent detection (content scan + CLAUDE.md on disk + path fallback)
- [x] Agent alias system (`--merge` false positives, retroactive re-tag)
- [x] No file size limit (300MB+ sessions in constant memory)
- [x] 40+ category auto-tagging (tech + personal/life categories)
- [x] Session bookmarking ("where did we leave off?" with cross-directory awareness)
- [x] Unified knowledge graph (topic/directory/project/agent nodes, materialized edges)
- [x] Benchmark scripts (LongMemEval ingest + retrieval)
- [x] L-tier validation (classify, validate, idempotent compression)
- [x] L1 hot memory block generator
- [x] Atomic personality switch (transaction + checkpoint + restore)
- [x] Crash recovery (session health check, auto-recover on startup)
- [x] Safe delete/purge (cascade, dry-run, --force gates)
- [x] Doctor CLI + MCP (`wmem_status`, `wmem_doctor`, `wmem_dedup`)
- [x] Session hooks (SessionStart + SessionEnd)
- [x] Preamble stripping on ingest
- [x] Import registry with staleness detection
- [x] Cross-platform support (Linux, macOS, Windows)
- [x] MIT License
- [x] **(v1.2)** Multi-instance safety: `wmem_role` table + role gate (writes refused on non-master)
- [x] **(v1.2)** `GET /api/wmem/role` endpoint for client probes
- [x] **(v1.2)** `POST /api/write` generic dispatcher (22 ops, server-side allowlist)
- [x] **(v1.2)** `wmem-outbox` daemon — local proxy with offline buffering + drain on reconnect
- [x] **(v1.2)** Interactive port picker (`scripts/configure-ports.mjs`) — probe + prompt + write `wmem.config.json`
- [x] **(v1.2)** Tests: role gate, dispatcher, outbox passthrough/buffer/drain
- [x] Preference signals aggregation (`aggregatePreferences` in `core/db.mjs`)
- [x] Batch purge size limit (500/batch under SQLite 999 param cap — `core/doctor.mjs`)

## Roadmap (v1.3+)

- [ ] Mid-session L1 refresh (time-based, every 30min)
- [ ] Drift supervisor (catches mid-session — temporal anchor, capability staleness, fact contradictions; signals already in L1)
- [ ] Session hooks auto-registration in setup script
- [ ] Hook-based auto-bookmarking on session end (table + materializer exist via `reimport`; hook wiring pending)
- [ ] Hook-based KG materialization (`materializeTopicRelations` exists; hook wiring pending)
- [ ] L1 pick-up prompt ("you were also working on X in another folder")
- [ ] `wmem personality generate` — interactive personality builder
- [ ] `personality update` CLI command (create/delete/use exist; update missing)
- [ ] Build tools detection in setup script (Windows VS Build Tools, macOS Xcode CLI tools)
- [ ] Plugin architecture for extending wmem
- [ ] Secret scanning in doctor (`--secrets` flag) — `core/secret-patterns.mjs` exists and is wired into `memory_amend` previews; wiring into `wmem_doctor` pending
- [ ] Speaker-attribution surface (`writtenBy` / `about` on ingest path; schema exists in `0004_messages_and_written_by.sql`)
- [ ] Run `wmem-eval` benchmark and publish retrieval scores in README
- [ ] npm publish flow (`prepublishOnly`, `.npmignore`, automated version tagging)
- [ ] `examples/multi-instance-walkthrough.mjs` — runnable demo of master + mirror + outbox topology
- [ ] CI workflow (GitHub Actions running `npm test` on push + PR)

## Examples

- [`examples/preference-loop-walkthrough.mjs`](./examples/preference-loop-walkthrough.mjs) — runnable demo of the zero-LLM preference consolidation loop (tier 1 signals → tier 2 preferences → tier 3 facts). Observable output at each stage. Run against a scratch DB:
  ```bash
  MEMORY_DB=/tmp/wmem-pref-demo.db node examples/preference-loop-walkthrough.mjs
  ```

## Documentation

- [Architecture](./docs/architecture.md) — system overview, data flow, all layers
- [Setup Guide](./docs/setup-guide.md) — prerequisites, installation, troubleshooting
- [MCP Tools Reference](./docs/mcp-tools.md) — all 69 stdio tools + v1.2 HTTP API surface
- [Personalities Guide](./docs/personalities.md) — identity management, templates, shared memory
- [Search Guide](./docs/search-guide.md) — FTS5 syntax, scopes, snippets, graph queries
- [Decision Engine](./docs/decision-engine-usage.md) — proactive behavior, salience scoring
- [Contributing](./docs/contributing.md) — dev setup, code style, architecture rules

## Design Principles

- **L1 is a script, not a model call.** Zero API cost. No hallucination risk.
- **FTS5 before semantic search.** Cheapest layer first.
- **The memory system is invisible.** The user sees remembering, not retrieval.
- **Memories organize themselves.** Auto-tags, not manual folders.
- **Identity is portable.** Export a personality, load it anywhere.
- **Silence is the default.** AI that knows when to shut up.
- **Atomic imports.** Whole file lands or none of it does.
- **Don't ask the LLM to decide silence.** Build a state machine.

## Secrets

**wmem is not a password manager.** By deliberate scope.

Encrypted-at-rest key-value storage (API tokens, credentials, private material) belongs in a specialized tool with a mature threat model. We recommend:

- [`pass`](https://www.passwordstore.org/) — GPG-backed, the UNIX-idiomatic answer
- OS keychain — libsecret (Linux), Keychain (macOS), Credential Manager (Windows)
- [`age`](https://age-encryption.org/) / [`sops`](https://github.com/getsops/sops) — file-level encryption
- 1Password CLI / Bitwarden CLI — if you already use a password manager

What wmem does provide:

**Secret pattern scanning + redaction.** `core/secret-patterns.mjs` recognizes common shapes (OpenAI / Anthropic / GitHub / AWS / GCP keys, JWTs, bearer tokens, PEM blocks, password assignments). Used in two places:

1. **Amend and delete previews.** When you call `memory_amend` or `memory_delete` on a chunk that contains a secret, the preview response redacts the secret before returning — so the secret never traverses an API response on its way to your review.
2. **Doctor scanner** (coming) — `wmem_doctor --secrets` surfaces chunks where secrets were accidentally indexed so you can amend or delete them.

**`memory_amend` tool.** If you find a leaked credential in memory, amend replaces the content in place (regenerates tags, drops the vector, FTS re-syncs). The original content is NOT preserved — this is redaction, not revision history. See `docs/mcp-tools.md`.

The design discipline: wmem ingests a lot. Sometimes it ingests something it shouldn't have. Our job is to help you find and remove those, not to become a storage backend for the thing that got ingested.

## History

The public repository starts at the point where the code was scrubbed for public release. Earlier development history is not published. Source of truth from the fork point forward is this repository.

## License

[MIT](./LICENSE)
