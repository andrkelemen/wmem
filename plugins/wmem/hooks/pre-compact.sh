#!/usr/bin/env bash
# wmem PreCompact hook — drop a sentinel so post-compact session knows
# preference consolidation is queued for this session.

set -euo pipefail

QUEUE_DIR="${HOME}/.wmem/queue"
mkdir -p "$QUEUE_DIR"

ts=$(date -u +%Y-%m-%dT%H-%M-%SZ)
agent="${WMEM_AGENT:-default}"
session="${CLAUDE_SESSION_ID:-unknown}"

cat > "${QUEUE_DIR}/precompact-${agent}-${ts}.json" <<EOF
{
  "agent": "${agent}",
  "session_id": "${session}",
  "queued_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "reason": "pre-compact",
  "todo": [
    "call preferences_pending",
    "for each pending session that matches yours: preferences_claim",
    "extract preferences from recent context",
    "call preferences_write per preference",
    "call preferences_complete to release the queue slot"
  ]
}
EOF

# PreCompact hooks emit top-level `additionalContext` — the
# hookSpecificOutput wrapper is reserved for PreToolUse / UserPromptSubmit /
# PostToolUse / PostToolBatch only. (Caught by nora 2026-05-17.)
cat <<EOF
{"additionalContext":"<wmem-precompact>\nPreference consolidation queued at ${QUEUE_DIR}. On next session start, drain the queue: preferences_pending → claim → write → complete.\n</wmem-precompact>"}
EOF
