# PostToolUse hook: auto-populate `session_files`

Wire this hook in Claude Code's `~/.claude/settings.json` to automatically record file activity as it happens. Zero-effort ~90% coverage of the tools that matter (Edit, Write, Read). The remaining ~10% (MultiEdit, NotebookEdit, etc.) can be added as you see them land.

## Sample config

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|Read",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/wmem/scripts/posttooluse-record-file.sh"
          }
        ]
      }
    ]
  }
}
```

## Reference hook script

`scripts/posttooluse-record-file.sh` (included in this repo):

```bash
#!/bin/bash
# Reads Claude Code's PostToolUse JSON on stdin, extracts tool_input.file_path,
# and records a session_files row via the MCP server's HTTP endpoint — or via
# direct node call if the MCP server runs in-process.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WMEM_DIR="${WMEM_DIR:-$(dirname "$SCRIPT_DIR")}"
[ -f "$HOME/.wmemrc" ] && . "$HOME/.wmemrc"
export MEMORY_DB="${MEMORY_DB:-$HOME/.wmem/memory.db}"

cd "$WMEM_DIR" || exit 0
node scripts/posttooluse-record-file.mjs 2>/dev/null
exit 0
```

## What the script does

1. Reads the JSON payload Claude Code pipes in:
   ```json
   {
     "session_id": "...",
     "tool_name": "Edit",
     "tool_input": { "file_path": "/absolute/path/to/file" }
   }
   ```
2. Maps `tool_name` to an operation:
   - `Read` → `read`
   - `Edit` / `MultiEdit` → `edit`
   - `Write` → `edit` if file existed before else `create`
   - (deletions aren't a standard tool — record manually via `session_file_touch` when needed)
3. Calls `touchSessionFile({ sessionId, path, operation })` which auto-scopes the path against registered `project_scope_paths`.
4. Exits 0 silently — a hook failure must not block the tool call.

## Backfill for historical data

For chunks that already exist before this hook is wired:

```bash
node scripts/backfill-scopes.mjs
# or filtered:
node scripts/backfill-scopes.mjs --agent primary --session <id>
node scripts/backfill-scopes.mjs --dry-run
```

The backfill scans existing chunk content for absolute-path mentions, matches them against registered scope prefixes, and inserts `session_files` rows with `chunk_id` already populated. Idempotent — re-running won't duplicate rows.

## Verifying it works

After wiring:

```bash
# Touch a file in a Claude Code session, then:
sqlite3 ~/.wmem/memory.db "SELECT session_id, scope, path, operation, occurred_at FROM session_files ORDER BY id DESC LIMIT 5;"
```

You should see a row per Edit/Write/Read tool call, auto-scoped if the file is under a registered prefix.
