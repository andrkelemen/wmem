#!/bin/bash
# wmem session-start hook for Claude Code
#
# Loads the active personality, indexes new content, generates L1.
# Everything is injected via additionalContext.
#
# Config (env vars or ~/.wmemrc):
#   MEMORY_DB     — path to SQLite DB (default: ~/.wmem/memory.db)
#   WMEM_AGENT    — agent name override (default: from active personality, or 'default')
#   WMEM_SCAN_DIR — JSONL directory (default: ~/.claude/projects)
#   WMEM_BORN     — agent birth date override (default: from active personality)
#   WMEM_DIR      — path to wmem repo (auto-detected from script location)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WMEM_DIR="${WMEM_DIR:-$(dirname "$SCRIPT_DIR")}"

# Source user config if it exists
[ -f "$HOME/.wmemrc" ] && . "$HOME/.wmemrc"

export MEMORY_DB="${MEMORY_DB:-$HOME/.wmem/memory.db}"
SCAN_DIR="${WMEM_SCAN_DIR:-$HOME/.claude/projects}"

# Ensure DB directory exists
mkdir -p "$(dirname "$MEMORY_DB")"

cd "$WMEM_DIR" || exit 0

# 1. Resolve active personality (if any)
PERSONALITY_JSON=$(node -e "
import { getActivePersonality, buildPersonalityL1 } from './core/personality.mjs';
const p = getActivePersonality();
if (p) {
  console.log(JSON.stringify({
    agent: p.name,
    born: p.born || null,
    l1: buildPersonalityL1(p)
  }));
} else {
  console.log(JSON.stringify({ agent: null, born: null, l1: null }));
}
" 2>/dev/null)

# Extract agent and born from personality (env overrides take precedence)
P_AGENT=$(echo "$PERSONALITY_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('agent') or '')" 2>/dev/null)
P_BORN=$(echo "$PERSONALITY_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('born') or '')" 2>/dev/null)
P_L1=$(echo "$PERSONALITY_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('l1') or '')" 2>/dev/null)

AGENT="${WMEM_AGENT:-${P_AGENT:-default}}"
BORN="${WMEM_BORN:-${P_BORN:-}}"

# 2. Incremental index (stderr only — stdout reserved for JSON output)
node scripts/index-sessions.mjs --dir "$SCAN_DIR" --agent "$AGENT" 2>/dev/null

# 3. Generate L1 block
BORN_FLAG=""
[ -n "$BORN" ] && BORN_FLAG="--born $BORN"
# CLAUDE_PROJECT_DIR is set by Claude Code; fall back to PWD for standalone use.
CWD_FOR_L1="${CLAUDE_PROJECT_DIR:-$PWD}"
L1=$(node scripts/generate-l1.mjs --agent "$AGENT" --directory "$CWD_FOR_L1" $BORN_FLAG 2>/dev/null)

# 4. Prepend personality L1 section if active
if [ -n "$P_L1" ]; then
  L1="${P_L1}

${L1}"
fi

# 5. Output as Claude Code hook JSON
if [ -n "$L1" ]; then
  L1_ESCAPED=$(printf '%s' "$L1" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))" 2>/dev/null)
  if [ -z "$L1_ESCAPED" ]; then
    L1_ESCAPED=$(printf '%s' "$L1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | awk '{printf "%s\\n", $0}')
    L1_ESCAPED="\"$L1_ESCAPED\""
  fi
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": ${L1_ESCAPED}
  }
}
EOF
fi

exit 0
