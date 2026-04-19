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
node scripts/index-sessions.mjs --dir "$SCAN_DIR" --agent "$AGENT" 2>/dev/null

# Enqueue the session for preference consolidation.
# Claude Code passes session metadata on stdin as JSON; pipe it through.
# If stdin is empty (manual invocation), we fall back to env vars inside the script.
node scripts/session-end-enqueue.mjs --agent "$AGENT" 2>/dev/null

exit 0
