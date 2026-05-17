# MCP Tools Reference

> 69 tools available via the wmem MCP server. Registered with `claude mcp add`.

## Memory

### memory_search
Auto-routes between hybrid (FTS5 + vector + session dedupe) and tag-boosted FTS5 based on whether the DB has vector embeddings. Response header tags the mode (`[hybrid]` or `[fts5]`).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| query | string | yes | Search query (FTS5 syntax: AND, OR, NOT, phrases) |
| agent | string | no | Filter by agent/personality |
| type | string | no | Filter by source type |
| scope | string | no | `default` (shared + active), `private`, `shared`, `all` |
| limit | number | no | Max results (default 20) |
| noHybrid | boolean | no | Force FTS5 path even if vectors exist |

Multi-word queries without explicit operators auto-convert to OR.
FTS5 results are tag-boosted when chunk tags overlap with query-derived tags.
Hybrid results are session-deduped so the top K represents K distinct sessions.
Embedder loads lazily on first hybrid call (~3s) and stays warm for the process.

### memory_ingest
Store content manually. Auto-embeds the new chunk when the DB has vectors.

| Param | Type | Required |
|-------|------|----------|
| agent | string | yes |
| sourceType | string | yes |
| content | string | yes |
| sourceId | string | no |

Embedding failure is non-fatal; the chunk stays searchable via FTS5.

### memory_reimport
Backfill enrichment on existing data. Idempotent — safe to re-run. Skip already-processed chunks per step.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| agent | string | no | Filter to a single agent |
| steps | string | no | `all` (default, fast), `all+embeddings` (full, slow), or one of: `facts`, `preferences`, `tags`, `bookmarks`, `kg`, `embeddings` |

`embeddings` is not included in `all` because it's CPU-bound (~10-50ms per chunk). Run explicitly when you're ready to enable hybrid search:

```
memory_reimport steps="embeddings"
```

After that run completes, future `memory_search` calls automatically use the hybrid path. No config required.

### memory_l1
Generate L1 hot memory block.

| Param | Type | Required |
|-------|------|----------|
| agent | string | yes |
| born | string | no | ISO 8601 date for temporal anchor |

### memory_capabilities
Return the capabilities list from capabilities.md.

### memory_recent
Recent chunks by agent.

| Param | Type | Required |
|-------|------|----------|
| agent | string | yes |
| limit | number | no |
| type | string | no |

### memory_stats
Index statistics: total chunks, breakdown by agent and source type.

### memory_share
Share a chunk across all personalities. Copies to `_shared` partition.

| Param | Type | Required |
|-------|------|----------|
| chunk_id | number | yes |

Cannot share chunks marked as `personal`.

### memory_personal
Lock a chunk to this personality permanently. Cannot be shared.

| Param | Type | Required |
|-------|------|----------|
| chunk_id | number | yes |

## Projects

### project_update
Create or update a project's state.

| Param | Type | Required |
|-------|------|----------|
| name | string | yes |
| status | string | no | active, shipped, abandoned, blocked |
| summary | string | no |
| pending | string | no |
| shipped | string | no |
| agent | string | no |
| giteaRepo | string | no |

### project_ship
Mark a project as shipped.

| Param | Type | Required |
|-------|------|----------|
| name | string | yes |
| note | string | no |

### project_list
List projects by status.

| Param | Type | Required |
|-------|------|----------|
| status | string | no | Filter: active, shipped, abandoned, blocked |

## Personality

### personality_use
Switch the active personality.

| Param | Type | Required |
|-------|------|----------|
| name | string | yes |

### personality_list
List all personalities. Shows which is active.

### personality_create
Create a new personality.

| Param | Type | Required |
|-------|------|----------|
| name | string | yes |
| template | string | no | coder, architect, reviewer, writer, researcher, confidant |
| displayName | string | no |
| description | string | no |
| systemPrompt | string | no |
| voice | string | no |
| born | string | no |

### personality_show
Show personality details.

| Param | Type | Required |
|-------|------|----------|
| name | string | no | Defaults to active personality |

### personality_file_set
Create or update a personality file.

| Param | Type | Required |
|-------|------|----------|
| personality | string | yes |
| filename | string | yes |
| content | string | yes |
| always_load | boolean | no | If true, injected into L1 every session |

### personality_file_list
List files for a personality.

| Param | Type | Required |
|-------|------|----------|
| personality | string | no | Defaults to active |

## Knowledge Graph

### graph_related
Find chunks related to a topic by tag co-occurrence.

| Param | Type | Required |
|-------|------|----------|
| topic | string | yes |
| agent | string | no |
| depth | number | no | 1 = direct tags, 2 = + co-session (default 2) |
| limit | number | no |

### graph_topics
Find topics that co-occur with a given topic.

| Param | Type | Required |
|-------|------|----------|
| topic | string | yes |
| agent | string | no |
| limit | number | no |

### graph_path
Find the relationship between two topics.

| Param | Type | Required |
|-------|------|----------|
| topicA | string | yes |
| topicB | string | yes |
| agent | string | no |

### graph_map
Build the full topic graph (nodes + edges).

| Param | Type | Required |
|-------|------|----------|
| agent | string | no |
| minWeight | number | no | Minimum shared sessions (default 2) |

## Session Recall

### memory_last_session
Recall where we left off. Returns the last session in the current directory PLUS parallel work in other directories (same project, shared tags, or time overlap).

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| agent | string | no | Defaults to active personality |
| project | string | no | Filter by project name |
| directory | string | no | Filter by working directory |

Returns: current directory session (summary, files touched, tags, recent chunks) + parallel work across other directories ranked by relevance.

### memory_sessions
List recent session bookmarks.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| agent | string | no | Defaults to active personality |
| project | string | no | Filter by project name |
| limit | number | no | Max sessions (default 10) |

## System

### memory_import
Import a file or raw text into memory. Supports markdown (section splitting) and plain text.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| file | string | no | File path to import |
| text | string | no | Raw text to import (alternative to file) |
| agent | string | no | Agent to import under (default: active) |
| source | string | no | Source label |
| dryRun | boolean | no | Preview without writing |

### memory_delete
Delete a specific chunk. Two-step: first call shows preview (secrets auto-redacted in preview output), second with `confirm=true` executes.

| Param | Type | Required |
|-------|------|----------|
| chunk_id | number | yes |
| confirm | boolean | no | Set true to execute (first call previews) |

### memory_amend
Redact a chunk's content in place. Use when a leaked API key, password, or other sensitive content was accidentally indexed and you want it out without destroying the surrounding context. The original content is NOT preserved — this is redaction, not revision history.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| chunk_id | number | yes | Chunk ID to amend |
| new_content | string | no | Replacement content. Defaults to a dated redaction marker if omitted. |
| reason | string | no | Optional reason recorded in `metadata.amended_reason` |
| confirm | boolean | no | Set true to execute (first call previews; secrets auto-redacted in the preview) |

Effects: content replaced, tags regenerated from new content, vector dropped (redacted content is not worth embedding), FTS5 re-syncs via trigger. Chunk ID stays stable.

### wmem_status
Full status report: chunks, sessions, agents, personality, DB size, imports, staleness.

### wmem_doctor
Run integrity checks: orphan tags, duplicate chunks, stale sessions, missing hashes.

### wmem_dedup
Remove duplicate chunks. Keeps the oldest copy, deletes newer duplicates.

## HTTP API (service mode, v1.2)

When running `node server.mjs` (instead of or alongside the stdio MCP), wmem exposes an HTTP surface. The full endpoint inventory:

### Reads (never gated)
- `GET /api/search?q=&agent=&type=&limit=` — FTS5 / hybrid search
- `GET /api/recent?agent=&type=&limit=` — newest-first chunks
- `GET /api/stats` — DB stats
- `GET /api/mail/inbox/:agent`, `/api/mail/outbox/:agent`, `/api/mail/thread/:id`, `/api/mail/counts`
- `GET /api/wmem/role` — current role + writable flag + hostname
- `GET /health` — liveness probe

### Writes (gated by `wmem_role = master`)
- `POST /api/ingest` — store chunks
- `POST /api/amend` — redact-in-place
- `POST /api/import` — import a file
- `POST /api/reimport` — re-import a previously imported file
- `POST /api/preferences/write`, `POST /api/facts/write`
- `POST /api/capabilities/{add,update,remove}`
- `POST /api/mail/send`, `POST /api/mail/reply/:id`, `POST /api/mail/read/:id`, `POST /api/mail/unread/:id`
- `POST /api/write` — generic dispatcher (see below)

### POST /api/write — generic write dispatcher

Single endpoint for write ops that don't have a dedicated REST route. Server-side allowlist controls which ops are valid.

**Request:**
```json
{ "op": "namespace.verb", "args": { ... } }
```

**Success:**
```json
{ "ok": true, "op": "...", "result": { ... } }
```

**Unknown op (404):**
```json
{ "error": "unknown_op", "op": "...", "known_ops": [ "...", "...", ... ] }
```

**Missing op (400):**
```json
{ "error": "missing_op", "note": "body must be { op: \"ns.verb\", args: {...} }" }
```

**Refused on non-master (403):** the role gate fires before the dispatcher.

**Op catalogue (22):**

| Op | Args | Effect |
|----|------|--------|
| `memory.amend` | `chunk_id, new_content, reason` | Redact a chunk in place |
| `memory.share` | `chunk_id` | Flip scope to shared |
| `memory.personal` | `chunk_id` | Flip scope to private |
| `project.upsert` | `name, status, summary, pending, shipped, agent, giteaRepo, metadata` | Create/update project |
| `project.ship` | `name, note` | Mark project shipped |
| `project.scope.upsert` | `code, name, description` | Register a path-scope |
| `project.scope.path.upsert` | `scope, platform, pathPrefix` | Bind a path prefix to a scope per platform |
| `session.file.touch` | `sessionId, path, operation, chunkId` | Record file-touched-during-session |
| `personality.upsert` | `id, name, role, metadata` | Create/update personality registry row |
| `personality.delete` | `id` | Remove personality |
| `personality.enable` | `id, enabled` | Enable/disable personality |
| `personality.sfw` | `id, sfw` | Set SFW flag |
| `personality.activate` | `id, caller, reason` | Mark personality active (audited) |
| `personality.file.set` | `personality, filename, content, alwaysLoad, sortOrder` | Set a personality file |
| `personality.core.{add,update,delete}` | `personalityId, category, key, content[, locked]` | Manage core (sticky) traits |
| `personality.trait.{add,update,enable,disable,delete}` | `personalityId, category, key, [content, priority, enabled, confidence]` | Manage soft traits |
| `personality.trait.promote` | `traitId, category, key, content` | Promote trait → core |

### Bearer auth

When `WMEM_TOKEN_FILE` points at a file containing a token ≥32 chars, all write endpoints (including `/api/write`) require `Authorization: Bearer <token>`. Reads remain unauthenticated. Timing-safe comparison via `crypto.timingSafeEqual`. Auth is **disabled by default** — set the env var to enable.

### Caller identity

`X-Caller: <agent_id>` header on any HTTP request identifies the calling agent for `written_by` attribution and ownership checks. The MCP server stamps it from `WMEM_CALLER` env. Falls back to `NULL` if absent (graceful degradation).

### wmem-outbox endpoints (modules/wmem-outbox/src/server.mjs)

When running an outbox daemon (typically on each non-master host), it exposes its own admin surface alongside the passthrough:

- `GET /health` — `{ ok, upstream_reachable, upstream_role, outbox_pending, outbox_dead_letter, last_drain_ts, last_drain_result }`
- `GET /role` — cached upstream role
- `POST /admin/drain` — force a drain tick
- `GET /admin/outbox` — list pending + dead-letter rows
- `DELETE /admin/outbox/dead-letter` — purge dead-letter queue

All other paths are forwarded to the upstream master.
