---
name: using-wmem
description: Use this skill at session start and any time you're about to say "I don't remember" or "I don't have context on." wmem is the persistent memory layer; search it before guessing.
---

# Using wmem

You have wmem — a persistent memory substrate backed by SQLite + FTS5. It survives between sessions and across compacts. **Search it before saying "I don't remember."**

## The four reflexes

1. **Before "I don't remember", search.** `memory_search` is fast (<10ms on typical DBs). It supports FTS5 syntax: AND, OR, NOT, quoted phrases.

   ```
   memory_search("api keys")           // find all chunks mentioning api keys
   memory_search("\"exact phrase\"")  // exact match
   memory_search("auth NOT oauth")     // boolean
   ```

2. **At session start, orient.** Call `project_list` to see what's active / blocked / shipped. Call `memory_l1` to get the hot context block (capabilities + temporal anchor + drift signals + recent corrections). These are cheap (<50ms each) and prevent the "I forgot what we were working on" failure mode.

3. **When you decide something with weight, ingest it.** `memory_ingest` stores a narrative chunk that survives compact. Format the source_id as:
   - `cNNN` for continuous arcs (multi-day work)
   - `dNNN` for single-day voltage moments
   - `<topic>-YYYY-MM-DD` for one-off decisions

4. **Project state is registry, not optional.** When a project's status changes (started, blocked, shipped, abandoned), call `project_update` or `project_ship` so future sessions don't see stale "in progress" state.

## When NOT to use wmem

- Code patterns, conventions, architecture — these are visible in the current project state; reading files is faster.
- Git history / who-changed-what — `git log` / `git blame` are authoritative.
- Ephemeral task tracking inside one session — use the task tool, not memory ingest.

## The discipline

Memory only works if you actually write to it AND actually read from it. The most common failure is one-sided: agents who write voltage chunks but never search before answering, or agents who search but never ingest new decisions. Both directions, always.

## Multi-instance topology (v1.2+)

If `WMEM_HTTP_URL` is set in your environment, writes route through an HTTP service (typically a local wmem-outbox daemon that buffers when the canonical master is unreachable). You don't need to think about routing — just use the MCP tools. The outbox handles offline buffering and drain-on-reconnect transparently.

If you ever need to verify which instance you're talking to, the `/api/wmem/role` endpoint reports `master` vs `mirror` vs `unknown`.
