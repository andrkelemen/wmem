#!/bin/bash
# wmem session-end hook for Claude Code
#
# Indexes any new JSONL content written during this session.
#
# Config (env vars):
#   MEMORY_DB     — path to SQLite DB (default: ~/.wmem/memory.db)
#   WMEM_AGENT    — agent name (default: default)
#   WMEM_SCAN_DIR — JSONL directory (default: ~/.claude/projects)
#   WMEM_DIR      — path to wmem repo (auto-detected from script location)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WMEM_DIR="${WMEM_DIR:-$(dirname "$SCRIPT_DIR")}"

# Source user config if it exists
[ -f "$HOME/.wmemrc" ] && . "$HOME/.wmemrc"

export MEMORY_DB="${MEMORY_DB:-$HOME/.wmem/memory.db}"
SCAN_DIR="${WMEM_SCAN_DIR:-$HOME/.claude/projects}"
AGENT="${WMEM_AGENT:-default}"

mkdir -p "$(dirname "$MEMORY_DB")"

cd "$WMEM_DIR" || exit 0

# Claude Code passes session metadata on stdin as JSON. Capture once, fan out
# to each downstream consumer so they each see their own copy.
STDIN_PAYLOAD=$(cat 2>/dev/null || true)

# 1. Incremental index — picks up any chunks written during this session.
node scripts/index-sessions.mjs --dir "$SCAN_DIR" --agent "$AGENT" 2>/dev/null

# 2. Enqueue the session for preference consolidation.
printf '%s' "$STDIN_PAYLOAD" | node scripts/session-end-enqueue.mjs --agent "$AGENT" 2>/dev/null

# 3. Bookmark + KG materialization for cross-session/cross-folder pickup.
#    Cheap; runs <100ms on small DBs, 1-2s on tens-of-thousands of chunks.
#    Set WMEM_SKIP_KG=1 if you need to skip materialization on slow hosts.
printf '%s' "$STDIN_PAYLOAD" | node scripts/session-end-bookmark.mjs --agent "$AGENT" 2>/dev/null

exit 0
