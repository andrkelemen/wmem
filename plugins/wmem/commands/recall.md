---
description: Search wmem for a topic and surface the top results. Shortcut for `memory_search`.
argument-hint: <query>
---

Search wmem for the topic `$ARGUMENTS`. Use `memory_search` with default settings (hybrid retrieval when vectors exist, FTS5 + tag-boost otherwise). Return the top 5-10 results, each with: timestamp, agent, source type, first 200 chars of content, and the chunk id.

If the result set is empty, say so explicitly and suggest broader query terms — don't fall back to general knowledge.
