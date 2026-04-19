# Contributing

## Development Setup

```bash
git clone https://github.com/andrkelemen/wmem.git
cd wmem
npm install
```

## Branch Convention

```
feature/<name>   — new functionality
fix/<name>       — bug fixes
docs/<name>      — documentation only
```

All work on feature branches. PRs to `main`.

## Code Style

- ES modules (`.mjs` extension)
- No TypeScript — plain JavaScript
- Minimal dependencies (better-sqlite3, sqlite-vec, @xenova/transformers, @modelcontextprotocol/sdk)
- Pure functions where possible
- Every module is testable independently

## Architecture Rules

- **No LLM calls for retrieval.** FTS5 + sqlite-vec handle search.
- **No LLM calls for decisions.** Thresholds and state machines.
- **Single .db file.** No external databases.
- **Zero API cost for core operations.** Embeddings are opt-in.
- **Same pattern everywhere:** inputs → state → thresholds → actions.

## Adding an MCP Tool

1. Add tool definition to `TOOLS` array in `mcp-server.mjs`
2. Add handler function
3. Add switch case
4. Add to `docs/mcp-tools.md`

## Adding an Auto-Tag Pattern

Edit `core/autotag.mjs`. Add to `TOPIC_PATTERNS` or `ACTION_PATTERNS`:

```javascript
{ pattern: /\b(kubernetes|k8s|pod|helm)\b/i, tag: 'k8s' },
```

## Testing

```bash
# Quick syntax check
node -c core/db.mjs && node -c mcp-server.mjs && echo "✓"

# Test with fresh DB
MEMORY_DB=/tmp/test.db node scripts/index-sessions.mjs --dir ~/.claude/projects --agent test --verbose

# Test search
MEMORY_DB=/tmp/test.db node -e "import {search} from './core/db.mjs'; console.log(search('test', {limit:3}))"

# Test personality
MEMORY_DB=/tmp/test.db node scripts/personality.mjs create test --template coder
```

## Leak Check

Before committing, verify no personal/private content leaked into the codebase:

```bash
grep -rIiE "your-private-terms-here" --include="*.mjs" --include="*.md" . | grep -v node_modules
```

## Commit Messages

```
feat: short description of new feature
fix: what was broken and how it's fixed
docs: what documentation changed
```

Include context in the body — what was the problem, what's the fix, how was it tested.
