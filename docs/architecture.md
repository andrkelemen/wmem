# Architecture

> How wmem is built. What each piece does. How they connect.

## Design Philosophy

Every piece of intelligence in wmem is the same pattern:

```
inputs → state machine → thresholds → actions
```

No LLM calls for retrieval, no LLM calls for decisions. Deterministic where possible, searchable always, invisible to the user.

## System Overview

```
┌──────────────────────────────────────────────────────┐
│                    Claude Code                        │
│  SessionStart hook → index + generate L1 + inject     │
│  SessionEnd hook   → index new content                │
│  MCP server        → 69 tools available during session│
└──────────┬───────────────────────────┬───────────────┘
           │                           │
    ┌──────▼──────┐            ┌───────▼───────┐
    │   Hooks     │            │  MCP Server   │
    │ (shell/node)│            │ (stdio JSON)  │
    └──────┬──────┘            └───────┬───────┘
           │                           │
    ┌──────▼───────────────────────────▼───────┐
    │              Core Modules                 │
    │                                           │
    │  db.mjs          ← storage + search       │
    │  indexer.mjs     ← JSONL ingestion        │
    │  importer.mjs    ← markdown/text import   │
    │  context.mjs     ← time-windowed compress │
    │  embeddings.mjs  ← local vector embeddings│
    │  autotag.mjs     ← pattern-based tagging  │
    │  personality.mjs ← identity management    │
    │  decision.mjs    ← proactive behavior     │
    │  graph.mjs       ← knowledge relationships│
    └──────────────────┬───────────────────────┘
                       │
              ┌────────▼────────┐
              │  SQLite + FTS5  │
              │  + sqlite-vec   │
              │  (one .db file) │
              └─────────────────┘
```

## Storage Layer (core/db.mjs)

Single SQLite database with multiple virtual tables:

### Tables

| Table | Purpose |
|-------|---------|
| `chunks` | All indexed content (conversations, imports, identity) |
| `chunks_fts` | FTS5 virtual table for keyword search |
| `chunks_vec` | sqlite-vec virtual table for vector search |
| `sessions` | Tracks JSONL files and byte offsets for incremental indexing |
| `session_bookmarks` | Session summaries with directory, project, tags for recall |
| `tags` | Auto-generated topic tags per chunk |
| `projects` | Project lifecycle tracking (active/shipped/blocked) |
| `personalities` | Personality definitions and activation state |
| `personality_files` | Named documents per personality |
| `import_registry` | Tracks imported files and their hashes for staleness detection |
| `agent_aliases` | Maps detected agent names to canonical names |
| `kg_relations` | Unified knowledge graph edges (topic/directory/project/agent nodes) |
| `checkpoints` | Personality switch checkpoints for atomic rollback |

### Retrieval Pipeline

```
query → expansion (200+ synonyms) → FTS5/vector → cross-encoder rerank → results
```

For temporal questions: sub-query splitting runs before retrieval.

1. **Query expansion** — static synonym maps, zero LLM (expander.mjs)
2. **FTS5 keyword search** — exact match, <10ms. Auto-converts multi-word queries to OR.
3. **sqlite-vec semantic search** — local embeddings via transformers.js. ~50ms.
4. **Hybrid search** — weighted merge of BM25 + cosine similarity (0.6/0.4 default).
5. **Cross-encoder reranker** — ms-marco-MiniLM-L-6-v2, 22MB. Scores query-document pairs by raw logits. ~250ms/query GPU.
6. **Sub-query splitting** — multi-event temporal → independent searches → merge (subquery.mjs)
7. **Fact extraction** — 25+ regex patterns at ingest time (facts.mjs)
8. **Temporal resolver** — natural language dates → timestamp ranges (temporal.mjs)

### Privacy Model

Every chunk has a `privacy` field:
- `private` — only the owning personality sees it (default)
- `shared` — all personalities see it (via `_shared` agent)
- `personal` — locked permanently, `memory_share` refuses to copy it

### Dedup

MD5 hash of whitespace-normalized content. Same content for the same agent+source_type is stored once.

## Indexing Layer (core/indexer.mjs)

### JSONL Session Indexer

Scans Claude Code JSONL session files. Tracks byte offsets per file — only reads new content on subsequent runs.

```
JSONL file → streaming reader (8MB chunks) → extract messages → auto-tag → insert chunks
```

- Streams in 8MB chunks (handles 300MB+ files in constant memory)
- Extracts: text, thinking blocks, tool_use inputs, tool results, system messages, attachments
- Preamble stripping: removes "You are reading chunk X of 22..." headers
- Validates trailing lines (crash-safe)
- `--force` flag re-indexes from byte 0

### Auto-Agent Detection

Detects which agent/personality a session belongs to:

1. **JSONL content scan** (128KB) — "I am X", "CLAUDE.md — I Am X", name as first word
2. **CLAUDE.md on disk** — decodes project dir to cwd, reads CLAUDE.md identity
3. **Path-based fallback** — `C--Users-alice` → `alice`
4. **Default** — `default`

### Universal Importer (core/importer.mjs)

Imports markdown, plain text, system prompts:
- Splits markdown by `##` headers into independent searchable chunks
- Classifies: personality vs memory vs config (with confidence scores)
- Low confidence → flagged for review, not guessed
- Atomic imports (SQLite transaction)
- Source tracing: file + section + line number
- Import registry tracks file hashes for staleness

## Context Layer (core/context.mjs)

Time-windowed compression for L1 hot memory block:

```
last 2 hours:  500 chars/message — full texture
2-6 hours:     200 chars/message — conversation flow
6-18 hours:    80 chars/message  — decisions and turning points
18+ hours:     dropped from L1 (still searchable in L2)
```

## Identity Layer (core/personality.mjs)

Each personality is a complete agent identity:
- Name, display name, description
- System prompt (injected into every session)
- Voice (tone/style description)
- Capabilities and restrictions
- Decision config (proactive behavior thresholds)
- Personality files (named documents, optionally always-loaded into L1)
- Born date (for temporal anchor)

Personalities are partitions. Each has its own memory. `_shared` is the cross-personality partition.

5 built-in templates: coder, architect, reviewer, writer, researcher.

## Decision Layer (core/decision.mjs)

Determines when the agent should speak vs stay silent. Deterministic state machine with auditable thresholds — see core/decision.mjs.

### Salience Scoring

```
salience = eventWeight × personalityModifier × contextModifier
```

### Output Modes

- **SILENCE** — do nothing (default, most common)
- **NOTIFY** — logged, searchable, not pushed
- **SPEAK** — deliver via preferred channel
- **ACT** — execute action without speaking

### Event Categories

- **I1**: explicitly requires response (errors, anomalies)
- **I2**: contextually suggests response (arrivals, pattern deviations)
- **S1**: routine noise (session end, status checks)
- **S2**: noted for record (task completed, memory matches)

## Knowledge Layer (core/graph.mjs)

Lightweight knowledge graph via co-occurrence. No graph database.

- **findRelated(topic)** — chunks sharing tags or sessions with the topic
- **relatedTopics(topic)** — tags that co-occur with the given topic
- **topicPath(a, b)** — shared sessions between two topics
- **buildTopicGraph()** — full nodes + edges for visualization

All pure SQLite queries over existing tags + sessions tables.

## Embedding Layer (core/embeddings.mjs)

Local embeddings via transformers.js:
- Model: all-MiniLM-L6-v2 (22MB, 384 dimensions)
- CPU-only, no GPU required
- Downloaded once on first use, cached locally
- Opt-in via `--embed` flag during indexing

## L1 Generation (scripts/generate-l1.mjs)

Generates the hot memory block loaded on every session start:

```
TEMPORAL ANCHOR: date, agent age
PERSONALITY: system prompt + voice + always-load files
CAPABILITIES: manually maintained list
RECENT SESSIONS: time-windowed compression
PROJECTS: active/shipped/blocked
RULES: search before saying "I don't remember"
```

~1,200 tokens. Pure template, zero API cost.

## MCP Server (mcp-server.mjs)

28 tools over stdio transport. Registered via `claude mcp add`.

See [MCP Tools Reference](./mcp-tools.md) for the full list.

## Data Flow

### Session Start
```
hook fires → index new JSONL lines → generate L1 → inject into session context
```

### During Session
```
user asks → agent uses MCP tools → memory_search, graph_related, etc.
```

### Session End
```
hook fires → index conversation content written during this session
```

### Import
```
setup.mjs → detect CLAUDE.md → split by sections → classify → insert atomically
```

## How Recovery Works

wmem assumes every session can end abruptly. The recovery system handles three scenarios:

### 1. Crash During Indexing
The byte-offset tracker only advances after chunks are committed. If the process dies mid-index, the next run re-reads from the last committed offset. Dedup prevents duplicates if some chunks were partially written.

### 2. Crash During Personality Switch
`atomicPersonalitySwitch()` wraps the switch in a SQLite transaction:
1. Create checkpoint (saves current personality name)
2. Deactivate all personalities
3. Activate new personality
If the process dies between steps 2 and 3, the transaction rolls back automatically (SQLite WAL mode). On next startup, `restoreCheckpoint()` can recover to the last known good state.

### 3. Crash During Import
Imports use SQLite transactions. The entire file's chunks land or none do. Half-imported state is impossible. The import registry only updates after the transaction commits.

### Recovery on Startup
```
session-start hook fires
  → check: is there a pending checkpoint with no matching active personality?
  → if yes: restore from checkpoint
  → check: are there sessions with byte offset > file size?
  → if yes: reset offset for those sessions
  → proceed with normal L1 generation
```

## Safe Purge Order

Deleting data must respect foreign key dependencies. The cascade order:

```
1. tags         (references chunks.id)
2. chunks_vec   (references chunks.id via rowid)
3. chunks       (FTS5 trigger auto-cleans chunks_fts)
4. sessions     (references agent name, not chunk IDs)
5. import_registry (references agent + file path)
6. personality_files (references personality name)
7. personalities (references name)
8. agent_aliases (references canonical name)
```

Delete in this order. Never delete chunks before tags — FK constraint will fail.

`purgeAgent()` handles steps 1-5. `purgePersonality()` handles 6-8 plus optionally calls `purgeAgent()` for the data.

After bulk deletes: `PRAGMA optimize` keeps SQLite healthy. Full `VACUUM` reclaims disk space but locks the DB briefly.
