#!/usr/bin/env bash
# wmem SessionEnd hook — index new chunks + enqueue preferences for consolidation
# + bookmark + KG materialization (v1.3 PR-A).
# Delegates to the existing scripts/session-end-hook.sh.

set -euo pipefail

WMEM_DIR="${WMEM_DIR:-$(cd "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/../.." && pwd)}"

if [ ! -f "$WMEM_DIR/scripts/session-end-hook.sh" ]; then
  exit 0
fi

bash "$WMEM_DIR/scripts/session-end-hook.sh"
