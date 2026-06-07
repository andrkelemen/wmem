# Personalities Guide

> Switch who the agent IS, not just what it remembers.

## What is a Personality?

A personality is a complete agent identity:
- **Name** — partition key for memories
- **System prompt** — injected into every session
- **Voice** — tone and style description
- **Capabilities** — what this personality can do
- **Restrictions** — what it shouldn't do
- **Decision config** — when to speak vs stay silent
- **Files** — named documents (identity, preferences, notes)
- **Born date** — for temporal anchor ("I am 15 days old")

Each personality has its own memory partition. Switch personality, switch memories.

## Quick Start

```bash
# Create from template
node scripts/personality.mjs create dev --template coder
node scripts/personality.mjs use dev

# List all
node scripts/personality.mjs list

# Show details
node scripts/personality.mjs show dev

# Update fields later
node scripts/personality.mjs update dev --voice "Terse. No hedging." --capabilities "code,test,refactor"
```

## CLI Commands

| Command | Aliases | Description |
|---------|---------|-------------|
| `list` | `ls` | Show all personalities (active marked with →) |
| `use <name>` | `activate` | Activate a personality (takes effect next session) |
| `create <name> [--template t] [--interactive]` | | Create a new personality. `--interactive` walks through each field with defaults from the template if one is supplied. |
| `update <name> [flags]` | `edit` | Update fields on an existing personality. Pass any of `--display-name`, `--description`, `--voice`, `--prompt`, `--born`, `--capabilities a,b,c`, `--restrictions a,b,c`. Only fields you pass are touched. |
| `show [name]` | `info` | Show personality details (defaults to active) |
| `active` | | Show the active personality |
| `delete <name>` | `rm` | Delete a personality (memories are preserved — recreate to access them) |
| `templates` | | List built-in templates with descriptions |
| `import <file>` | | Import a personality from a JSON file |
| `export <name> [<file>]` | | Export to JSON (stdout if no file argument) |

### Interactive create

```bash
node scripts/personality.mjs create dawn --template confidant --interactive
```

Walks through each field, prefilling defaults from the template when provided. Press Enter on any prompt to accept the default. Requires a TTY — for scripted automation, use flag-based create instead.

### Targeted update

`update` only changes the fields you pass — everything else is left alone. Capabilities and restrictions take a comma-separated list and replace the existing list (they don't append).

```bash
# Just bump the voice and add a born date
node scripts/personality.mjs update dev --voice "Calmer. Asks more questions." --born 2026-01-15

# Swap the capability set
node scripts/personality.mjs update dev --capabilities "code,review,test,refactor,document"
```

## Built-in Templates

| Template | Threshold | Style | Description |
|----------|-----------|-------|-------------|
| **coder** | 0.6 (quiet) | Terse, technical | Writes code, never interrupts focus |
| **architect** | 0.55 | Analytical, asks questions | Plans before building |
| **reviewer** | 0.5 | Constructive, evidence-based | Finds issues, suggests fixes |
| **writer** | 0.65 (quietest) | Concise | Rarely speaks unprompted |
| **researcher** | 0.45 (most proactive) | Informative, cites sources | Actively shares findings |
| **confidant** | 0.8 (very quiet) | Diagnostic, thinking partner | Diagnoses before proposing, high threshold |

## Custom Personality

```javascript
import { createPersonality, activatePersonality } from './core/personality.mjs';

createPersonality({
  name: 'ops',
  displayName: 'DevOps',
  description: 'Infrastructure and deployment specialist',
  systemPrompt: 'You are a DevOps engineer. Focus on reliability, automation, and monitoring.',
  voice: 'Calm under pressure. Thinks in systems.',
  capabilities: ['deploy', 'monitor', 'debug infrastructure', 'write terraform'],
  restrictions: ['always check staging before production'],
  born: '2025-06-01',
});

activatePersonality('ops');
```

## Personality Files

Named documents that persist across sessions. Like CLAUDE.md sections but stored in the DB and portable.

```bash
# Via MCP tool
personality_file_set --personality dev --filename preferences.md --content "I prefer TypeScript." --always_load true

# always_load = true → injected into L1 every session
# always_load = false → searchable but not auto-loaded
```

Use for: identity notes, coding preferences, project context, team info.

## Decision Config

Each personality defines its own proactive behavior thresholds:

```json
{
  "decision": {
    "actionThreshold": 0.6,
    "cooldownMinutes": 15,
    "quietHours": [1, 7],
    "maxUnpromptedPerHour": 3,
    "salienceModifiers": {
      "error": 1.3,
      "task_failed": 1.5
    },
    "responseStyle": {
      "maxWords": 10,
      "register": "technical",
      "asksQuestions": false
    },
    "interruptionPolicy": {
      "neverInterruptFocus": true
    }
  }
}
```

Same event, different personality, different behavior. See [Decision Engine](./decision-engine-usage.md).

## Shared Memory

Personalities share a `_shared` partition for facts everyone needs:
- Projects (shipped/active/blocked)
- Decisions
- Team knowledge

Private memories stay private. Personal memories (`memory_personal`) are locked permanently.

```
search scope: 'default'  → shared + active personality's private
search scope: 'private'  → only active personality
search scope: 'shared'   → only _shared
search scope: 'all'      → everything (personal chunks from others excluded)
```

## Export / Import

```bash
# Export personality to JSON
node scripts/personality.mjs export dev dev.json

# Import on another machine
node scripts/personality.mjs import dev.json
```

The JSON includes: name, system prompt, voice, capabilities, restrictions, decision config. Memories stay in the DB — they don't travel with the export (they're machine-specific).

## Switching

```bash
node scripts/personality.mjs use architect
```

Takes effect on next session start. The hook loads the new personality's system prompt + L1.

No restart needed. No migration. The partition key changes, the memory partition changes, the behavior changes.
