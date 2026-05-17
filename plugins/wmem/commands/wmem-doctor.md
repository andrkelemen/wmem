---
description: Run wmem integrity checks — orphan tags, duplicate chunks, stale sessions, missing hashes.
---

Call `wmem_doctor`. Surface any issues found. If everything is clean, say so in one sentence.

If duplicates are reported, suggest `wmem_dedup` to remove them. If orphaned tags are reported, suggest a re-index. If stale sessions are reported, suggest re-running the session indexer.
