# Setup Guide

> From zero to working wmem in one command.

## Prerequisites

- **Node.js 18+**
- **C++ build tools** (for better-sqlite3 native compilation):
  - Linux: `sudo apt install build-essential python3`
  - macOS: `xcode-select --install`
  - Windows: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++"
- **Claude Code** (for MCP registration)

## One-Command Setup

```bash
git clone https://github.com/andrkelemen/wmem.git
cd wmem
node scripts/setup.mjs --agent myname
```

This runs 9 steps automatically:
1. Detect OS (Linux/macOS/Windows)
2. Verify node 18+ in PATH
3. `npm install --production`
4. Create `data/` directory
5. Import CLAUDE.md + extra .md files
6. Index existing JSONL sessions
7. Create + activate personality
8. Register MCP via `claude mcp add -s user`
9. Verify: chunks, personality, MCP connection

### Flags

| Flag | Description |
|------|-------------|
| `--agent <name>` | Personality/agent name |
| `--born <date>` | Birth date (ISO 8601) for temporal anchor |
| `--dry-run` | Preview everything, write nothing |
| `--claude-dir <path>` | Custom .claude directory |
| `--scope <scope>` | MCP registration scope (default: user) |

### Preview First

```bash
node scripts/setup.mjs --agent myname --dry-run
```

Shows what would happen: how many sections in your CLAUDE.md, which get classified as personality vs memory, how many session files found, what the MCP registration command would be.

## Manual Setup

If you prefer to do it step by step:

### 1. Install

```bash
git clone https://github.com/andrkelemen/wmem.git
cd wmem
npm install
```

> Always run `npm install` on the target machine. Native bindings are platform-specific — copying `node_modules/` between OS will segfault.

### 2. Import Existing Files

```bash
# Import CLAUDE.md
node -e "import {importMarkdown} from './core/importer.mjs'; console.log(importMarkdown('~/.claude/CLAUDE.md', 'myname'))"

# Import all .md files
node -e "import {importDirectory} from './core/importer.mjs'; console.log(importDirectory('~/.claude', 'myname'))"
```

### 3. Index Sessions

```bash
# Index all JSONL session files
node scripts/index-sessions.mjs --dir ~/.claude/projects --agent myname --verbose

# With auto-agent detection
node scripts/index-sessions.mjs --dir ~/.claude/projects --auto-agent --verbose

# With vector embeddings (slower first run, ~10-50ms/chunk on CPU)
node scripts/index-sessions.mjs --dir ~/.claude/projects --agent myname --embed

# Embeddings auto-enabled when DB already has vectors (session hook uses this).
# --no-embed forces off even if vectors exist.

# Re-index everything (after upgrading wmem)
node scripts/index-sessions.mjs --agent myname --force --verbose
```

### Upgrading an existing install — enable hybrid search

If you already have wmem running with FTS5-only search and want to turn on hybrid (FTS5 + vector) search:

```bash
git pull

# One-time backfill — embeds every chunk in the DB that doesn't have a vector yet.
# Resumable; safe to re-run.
node scripts/reimport.mjs --embeddings-only

# Or do everything at once (facts + preferences + tags + bookmarks + KG + embeddings):
node scripts/reimport.mjs --with-embeddings
```

Once the backfill finishes, `memory_search` automatically routes through hybrid. Future `memory_ingest` calls and session-hook indexer runs auto-embed new chunks. Response headers tag which path ran (`[hybrid]` vs `[fts5]`).

No schema migration, no re-index required.

### 4. Create Personality

```bash
# From template
node scripts/personality.mjs create dev --template coder
node scripts/personality.mjs use dev

# Custom
node -e "
import {createPersonality, activatePersonality} from './core/personality.mjs';
createPersonality({
  name: 'myname',
  displayName: 'My Agent',
  description: 'My custom agent',
  systemPrompt: 'You are a helpful assistant.',
  voice: 'Clear and concise.',
  capabilities: ['code', 'search', 'explain'],
});
activatePersonality('myname');
"
```

### 5. Register MCP

```bash
claude mcp add -s user wmem -e "MEMORY_DB=/path/to/wmem/data/memory.db" -- node "/path/to/wmem/mcp-server.mjs"
```

Verify: `claude mcp list` — should show `wmem: ... ✓ Connected`

### 6. Generate L1

```bash
node scripts/generate-l1.mjs --agent myname --born 2025-01-15
```

## Configuration

### .wmemrc

Create `~/.wmemrc` for machine-specific settings (sourced by session hooks):

```bash
export MEMORY_DB="$HOME/.wmem/memory.db"
export WMEM_AGENT="myname"
export WMEM_BORN="2025-01-15"
export WMEM_SCAN_DIR="$HOME/.claude/projects"
```

### capabilities.md

Edit `capabilities.md` in the wmem directory. One line per capability:

```markdown
- Search codebase via ripgrep
- Deploy to production via PM2
- Send notifications via Slack webhook
- Query database via SQLite
```

This is loaded into L1 every session. The most valuable 30 seconds you'll spend.

## Troubleshooting

### MCP not connecting

wmem registers via `claude mcp add`, which writes to `~/.claude.json`. If you manually edited `~/.claude/settings.json` — that's a different file and is ignored for MCP config.

```bash
# Check registration
claude mcp list

# Re-register
claude mcp remove wmem -s user
claude mcp add -s user wmem -e "MEMORY_DB=/path/to/data/memory.db" -- node "/path/to/mcp-server.mjs"
```

### npm install fails on Windows

You need Visual Studio Build Tools with "Desktop development with C++" workload. `better-sqlite3` compiles native C++ bindings.

### Chunks missing after indexing

1. Check file size: files over 20MB were skipped in older versions. Update wmem and re-index with `--force`.
2. Check extractor: older versions dropped thinking blocks and tool_use. Update and `--force`.
3. Check agent: chunks might be under a different agent name. Use `memory_stats` to see breakdown.

### Search returns nothing

FTS5 defaults to OR for multi-word queries. For exact phrases, use quotes: `"exact phrase"`. For AND, use explicit: `word1 AND word2`.

## Multi-Machine Setup

wmem is portable. Copy the `.db` file to any machine with wmem installed.

```bash
# Export
scp /path/to/wmem/data/memory.db user@other:/path/to/wmem/data/

# Or: export a personality as JSON
node scripts/personality.mjs export myname myname.json
# Import on other machine
node scripts/personality.mjs import myname.json
```
