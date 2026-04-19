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
