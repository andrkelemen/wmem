---
description: Show project registry state (active / blocked / shipped / abandoned).
argument-hint: [status]
---

Call `project_list` with optional status filter `$1` (one of: active, blocked, shipped, abandoned; default: all).

For each project: status, name, summary, pending field (if any), agent owner, last_touched ("Nd ago"). Group by status. Highlight projects with empty `pending` fields as candidates for `project_update` cleanup.
