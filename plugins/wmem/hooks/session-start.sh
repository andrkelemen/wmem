#!/usr/bin/env bash
# wmem SessionStart hook — index + generate L1 hot block + inject as additionalContext.
# Delegates to the existing scripts/session-start-hook.sh, then re-emits its JSON.
# Plugin-aware: resolves WMEM_DIR from CLAUDE_PLUGIN_ROOT walking up two dirs.

set -euo pipefail

WMEM_DIR="${WMEM_DIR:-$(cd "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/../.." && pwd)}"

# Fall back to the script-relative path if the resolved WMEM_DIR doesn't have
# the expected shape (e.g. plugin installed outside the repo).
if [ ! -f "$WMEM_DIR/scripts/session-start-hook.sh" ]; then
  echo '{}' ; exit 0
fi

bash "$WMEM_DIR/scripts/session-start-hook.sh"
