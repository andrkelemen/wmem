# Search Guide

> How to find things in wmem.

## Retrieval Pipeline

The `memory_search` MCP tool auto-selects its path based on what's in the DB:

```
  chunks_vec populated? ─┬─ yes → hybrid (FTS5 + vector) → session dedupe → results
                         └─ no  → tag-boosted FTS5 → results
```

The response header reports which path ran (`[hybrid]` or `[fts5]`) so you can tell at a glance.

For benchmarks and offline experiments, `scripts/benchmark-experimental.mjs` layers on a cross-encoder reranker and query routing. Those stages are not in the interactive MCP search path — they're too slow per-request — but the portable architectural wins (hybrid + session dedupe) are.

No LLM in the pipeline. Query expansion uses static synonym maps. Embeddings are local (all-MiniLM-L6-v2, 22MB).

## Search Modes

wmem has three search modes, all in one SQLite file.

### 1. FTS5 Keyword Search (default without embeddings)

```
memory_search query="authentication token"
```

Fast (<10ms), zero cost. Uses SQLite FTS5 with porter stemming.

**Multi-word queries default to OR.** `authentication token` finds chunks containing either word. For AND, use explicit: `authentication AND token`. For exact phrases: `"authentication token"`.

Results are **tag-boosted**: chunks whose auto-tags (see below) match tags derived from the query rank higher. Boost formula: `|FTS5_rank| * (1 + 0.3 * tag_overlap_score)`. No flag needed, on by default.

### 2. Semantic Vector Search

Requires embeddings to exist in the DB. Populate via:

```
node scripts/reimport.mjs --embeddings-only
```

Or embed at ingest time via `--embed` on `scripts/index-sessions.mjs` (auto-enabled when the DB already has any vectors).

Uses all-MiniLM-L6-v2 (22MB, 384d, CPU-only). Finds conceptually similar content without keyword matches. "how to log in" matches chunks about "authentication flow" even if those exact words don't appear.

### 3. Hybrid Search (default when embeddings exist)

Combines FTS5 + vector search with weighted scoring (60% BM25 + 40% cosine similarity), then dedupes results by `session_id` so the top-K represents K distinct sessions rather than K chunks.

Automatic whenever `chunks_vec` has any rows. No flag required. Degrades gracefully to FTS5 if the embedder fails to load.

### Query Expansion

Automatic synonym expansion with 200+ mappings. Zero LLM cost.

`"what did I study"` → `"study" OR "degree" OR "university" OR "college" OR "major" OR "school"`

Stop words stripped, max 6 terms, max 5 expansions per term. Works with all search modes.

### Cross-Encoder Reranker

ms-marco-MiniLM-L-6-v2 (22MB). Scores query-document pairs by raw logits — higher = more relevant. Typical scores: +3.5 for relevant, -11.0 for noise.

Runs after FTS5/vector retrieval on the candidate pool (default: top 50 → reranked to top 5). ~250ms/query on GPU, ~400ms on CPU.

### Sub-Query Splitting

Detects multi-event temporal questions and searches each event independently:

- `"how many days between my birthday party and the conference?"` → search "birthday party" + search "conference" → merge by session overlap
- Handles: duration questions, ordering questions, comparison questions
- 71% detection rate on temporal benchmarks

## Search Scope

Control which memories are visible:

| Scope | Sees |
|-------|------|
| `default` | Shared (`_shared`) + active personality's private |
| `private` | Only active personality's chunks |
| `shared` | Only `_shared` chunks |
| `all` | Everything (excludes `personal` from other personalities) |

## FTS5 Syntax

| Syntax | Example | Meaning |
|--------|---------|---------|
| Space | `auth token` | OR (either word) |
| `AND` | `auth AND token` | Both words in same chunk |
| `OR` | `auth OR login` | Either word |
| `NOT` | `auth NOT oauth` | First but not second |
| `"..."` | `"refresh token"` | Exact phrase |
| `*` | `auth*` | Prefix match (authentication, authorize, etc.) |
| `NEAR` | `auth NEAR token` | Words near each other |

## Snippet Previews

Search results show text centered on the match, not the beginning of the chunk:

```
[1] (conversation/dev) ...the >>>authentication<<< flow uses JWT tokens stored in httpOnly cookies...
```

`>>>` and `<<<` mark where the search term matched. 40 tokens of context around each match.

## Knowledge Graph Queries

For relationship-style questions:

```
graph_related topic="auth"          → chunks related to authentication
graph_topics topic="auth"           → topics that co-occur with auth
graph_path topicA="auth" topicB="deployment"  → how auth relates to deployment
graph_map                           → full topic graph
```

## Session Recall

"Where did we leave off?" as a single tool call:

```
memory_last_session directory="/home/user/project"
```

Returns:
- **Current directory**: last session summary, files touched, tags, recent chunks
- **Parallel work**: other directories with related sessions (same project, shared tags, time overlap)
- **KG-based relations**: directories connected by project or topic

```
memory_sessions project="wmem" limit=5
```

Lists recent session bookmarks filtered by project.

## Search by Tag

Auto-tags are generated on ingest. 40+ categories:

`api`, `auth`, `automation`, `blocker`, `career`, `config`, `database`, `debugging`, `decision`, `deployment`, `devices`, `discovery`, `education`, `entertainment`, `family`, `filesystem`, `finance`, `fitness`, `fix`, `food`, `frontend`, `git`, `health`, `housing`, `language`, `medical`, `milestone`, `networking`, `observability`, `performance`, `pets`, `planning`, `preference`, `refactor`, `relationship`, `review`, `security`, `setup`, `shipped`, `social`, `testing`, `transport`, `travel`, `weather`

## Tips

- **Start broad, narrow down.** `deploy` finds more than `kubernetes helm chart deployment`.
- **Use OR for recall.** `blindfold gag chain` finds chunks with any of those words.
- **Use AND for precision.** `auth AND oauth AND refresh` requires all three.
- **Search before saying "I don't remember."** The memory is there. The search finds it.
- **Graph for relationships.** "What relates to X?" is `graph_related`, not `memory_search`.
