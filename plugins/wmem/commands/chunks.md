---
description: Show recent chunks for the active agent. Quick "what have I been writing" view.
argument-hint: [agent] [limit]
---

Call `memory_recent` for agent `$1` (default: the active personality from `personality_current`) with limit `$2` (default: 20).

For each chunk: id, timestamp (relative — "3h ago"), source type, first 100 chars of content. Sorted newest-first.
