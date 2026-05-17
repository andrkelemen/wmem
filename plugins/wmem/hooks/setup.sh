#!/usr/bin/env bash
# wmem plugin Setup hook — fires once on plugin install/first-run.
# Registers the wmem MCP server with `claude mcp add` if not already present.
# Idempotent: skips registration if `claude mcp list` already shows wmem.

set -euo pipefail

WMEM_DIR="${WMEM_DIR:-$(cd "${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}/../.." && pwd)}"
MCP_SERVER="${WMEM_DIR}/mcp-server.mjs"

# Plugin-cache layouts can vary across versions; if mcp-server isn't where we
# expect, surface the manual command and exit clean.
if [ ! -f "$MCP_SERVER" ]; then
  echo "wmem plugin Setup: mcp-server.mjs not found at $MCP_SERVER" >&2
  echo "  Register manually: claude mcp add wmem -- node /path/to/mcp-server.mjs" >&2
  exit 0
fi

# Already registered? Skip.
if claude mcp list 2>/dev/null | grep -q '^wmem\b'; then
  echo "wmem plugin Setup: MCP already registered" >&2
  exit 0
fi

# Default DB path inside the user's data dir (XDG-friendly + Windows-friendly).
MEMORY_DB="${MEMORY_DB:-$HOME/.wmem/memory.db}"
mkdir -p "$(dirname "$MEMORY_DB")"

echo "wmem plugin Setup: registering MCP server (db=$MEMORY_DB)" >&2
if claude mcp add wmem -s user -e "MEMORY_DB=$MEMORY_DB" -- node "$MCP_SERVER" 2>&1; then
  echo "wmem plugin Setup: ✓ MCP registered" >&2
else
  echo "wmem plugin Setup: ✗ MCP registration failed — register manually:" >&2
  echo "  claude mcp add wmem -s user -e \"MEMORY_DB=$MEMORY_DB\" -- node \"$MCP_SERVER\"" >&2
fi
