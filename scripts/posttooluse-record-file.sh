#!/bin/bash
# Claude Code PostToolUse hook — records file activity to wmem.
# Never blocks the tool call (exits 0 even on failure).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WMEM_DIR="${WMEM_DIR:-$(dirname "$SCRIPT_DIR")}"
[ -f "$HOME/.wmemrc" ] && . "$HOME/.wmemrc"
export MEMORY_DB="${MEMORY_DB:-$HOME/.wmem/memory.db}"

cd "$WMEM_DIR" || exit 0
node scripts/posttooluse-record-file.mjs 2>/dev/null
exit 0
