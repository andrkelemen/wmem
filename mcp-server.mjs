#!/usr/bin/env node
/**
 * wmem MCP Server
 *
 * Standalone MCP server for memory continuity.
 * No external dependencies beyond @modelcontextprotocol/sdk and better-sqlite3.
 * Ideas stolen from: claude-mem (observation hooks), mempalace (tiered retrieval),
 * autodream (consolidation). Code is ours. No imports from any of them.
 *
 * Tools:
 *   search         — FTS5 keyword search across all indexed content
 *   ingest         — store a chunk manually
 *   get_l1         — generate the L1 hot memory block for an agent
 *   capabilities   — return the capabilities list
 *   recent         — get recent chunks for an agent
 *   stats          — index statistics
 *
 * Transport: stdio (standard MCP protocol)
 * Storage: SQLite + FTS5 at data/memory.db
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { insertChunk, search, getRecent, getStats, getDb, upsertProject, getProjects, getProject, shipProject, getRecentSessions, getSessionChunks, hybridSearch, shareChunk, markPersonal, upsertBookmark, getLastSession, getRecentBookmarks, materializeTopicRelations, materializeDirectoryRelations, amendChunk } from './core/db.mjs';
import {
  listAgents, getAgent, upsertAgent,
  writePreference, listPreferences,
  writeFact, listFacts,
  enqueueReview, listPendingReviews, claimReview, completeReview,
  writeAnchor, listAnchors,
} from './core/agents.mjs';
import {
  detectPlatform,
  listScopes, upsertScope,
  listScopePaths, upsertScopePath,
  resolvePath,
  touchSessionFile, listSessionFiles, listFileSessions, listRecentFiles,
} from './core/scopes.mjs';
import * as previewUtils from './core/secret-patterns.mjs';
import { compressContext, summarizeSession } from './core/context.mjs';
import { indexSessions } from './core/indexer.mjs';
import { createPersonality, getPersonality, listPersonalities, activatePersonality, getActivePersonality, TEMPLATES, setPersonalityFile, listPersonalityFiles, getPersonalityFile } from './core/personality.mjs';
import { findRelated, relatedTopics, buildTopicGraph, topicPath, relatedDirectories, directoryTopics } from './core/graph.mjs';
import { runDoctor, getStatus, purgeAgent, dedup, atomicPersonalitySwitch } from './core/doctor.mjs';
import { runReimport } from './core/reimport.mjs';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Redirect console.log to stderr — MCP uses stdout for JSON-RPC
const _log = console.log;
console.log = (...args) => console.error('[wmem]', ...args);

// Caller identity + admin state moved to core/session-identity.mjs so tests
// can exercise state + admin gating directly. Module exports:
//   WMEM_CALLER (const), isAdmin(), getCurrentCaller(), getEnvAnchor(),
//   setCurrentCaller(), resolveCaller(), __resetForTests().
import {
  WMEM_CALLER,
  isAdmin,
  getCurrentCaller,
  getEnvAnchor,
  setCurrentCaller,
  resolveCaller,
} from './core/session-identity.mjs';

if (WMEM_CALLER) {
  console.error('[wmem] caller:', WMEM_CALLER);
}
if (isAdmin()) {
  console.error('[wmem] admin mode ENABLED — args.agent override + agent_switch permitted');
}

// ── Tool Definitions ──────────────────────────────────────────

const TOOLS = [
  {
    name: 'memory_search',
    description: 'Search across all indexed conversations, memory chunks, and observations. Use this BEFORE saying you don\'t remember something. FTS5 keyword search — supports AND, OR, NOT, phrases.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (FTS5 syntax)' },
        agent: { type: 'string', description: "Filter by agent name (e.g. 'primary', 'helper-1'). Omit to search all." },
        type: { type: 'string', description: 'Filter by source type (conversation, memory-chunk, identity, observation)' },
        scope: { type: 'string', description: "Visibility scope: 'default' (shared + active personality), 'private' (only active), 'shared' (only shared), 'all' (everything)" },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_ingest',
    description: 'Store a chunk of content in the memory index. Use for manually preserving important information.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Which agent this memory belongs to' },
        sourceType: { type: 'string', description: 'Type: conversation, memory-chunk, identity, scene-digest, observation' },
        content: { type: 'string', description: 'The content to index' },
        sourceId: { type: 'string', description: 'Optional source identifier (session ID, chunk hex, filename)' },
      },
      required: ['agent', 'sourceType', 'content'],
    },
  },
  {
    name: 'memory_l1',
    description: 'Generate the L1 hot memory block for an agent. Returns the always-loaded context: temporal anchor, capabilities, drift signals, recent corrections, active context.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: "Agent name (e.g. 'primary', 'helper-1')" },
        born: { type: 'string', description: "Agent birth date (ISO 8601, e.g. '2025-01-15'). Used for temporal anchor." },
      },
      required: ['agent'],
    },
  },
  {
    name: 'memory_capabilities',
    description: 'Return the capabilities list — things the agent can do that it will forget. Loaded from capabilities.md.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_recent',
    description: 'Get recent indexed chunks for an agent, ordered by timestamp descending.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name' },
        limit: { type: 'number', description: 'Max results (default 10)' },
        type: { type: 'string', description: 'Filter by source type' },
      },
      required: ['agent'],
    },
  },
  {
    name: 'memory_stats',
    description: 'Get index statistics: total chunks, breakdown by agent and source type.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'project_update',
    description: 'Create or update a project\'s state. Use when starting, shipping, or updating a project. This closes the loop — shipped projects stop appearing as "in progress" in future sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name (e.g. my-project, another-project, wmem)' },
        status: { type: 'string', description: 'active, shipped, abandoned, blocked' },
        summary: { type: 'string', description: 'One-line current state' },
        pending: { type: 'string', description: 'What remains to be done' },
        shipped: { type: 'string', description: 'What was delivered' },
        agent: { type: 'string', description: 'Primary agent/owner' },
        giteaRepo: { type: 'string', description: 'Gitea repo path (e.g. org/project)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'project_ship',
    description: 'Mark a project as shipped/completed. Closes the loop — the project moves from active to shipped in memory. Future sessions see "done" not "in progress."',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name' },
        note: { type: 'string', description: 'What was shipped (short summary)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'project_list',
    description: 'List all projects by status. Shows what\'s active, shipped, blocked, or abandoned. Use on session start to know what\'s in flight.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter: active, shipped, abandoned, blocked. Omit for all.' },
      },
    },
  },
  {
    name: 'personality_use',
    description: 'Switch the active personality. Changes agent identity, voice, capabilities, and memory partition. Takes effect on next session start.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Personality name to activate' },
      },
      required: ['name'],
    },
  },
  {
    name: 'personality_list',
    description: 'List all available personalities. Shows which one is active.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'personality_create',
    description: 'Create a new personality. Optionally use a built-in template (coder, architect, reviewer, writer, researcher).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique personality name (becomes the agent partition key)' },
        template: { type: 'string', description: 'Built-in template: coder, architect, reviewer, writer, researcher' },
        displayName: { type: 'string', description: 'Human-readable name' },
        description: { type: 'string', description: 'One-line description' },
        systemPrompt: { type: 'string', description: 'System prompt injected into session context' },
        voice: { type: 'string', description: 'Tone/style description' },
        born: { type: 'string', description: 'Birth date (ISO 8601) for temporal anchor' },
      },
      required: ['name'],
    },
  },
  {
    name: 'personality_show',
    description: 'Show details for a personality — system prompt, voice, capabilities, restrictions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Personality name (omit for active)' },
      },
    },
  },
  {
    name: 'memory_share',
    description: 'Share a memory chunk across all personalities. Makes it visible to everyone. Cannot share chunks marked as personal.',
    inputSchema: {
      type: 'object',
      properties: {
        chunk_id: { type: 'number', description: 'ID of the chunk to share' },
      },
      required: ['chunk_id'],
    },
  },
  {
    name: 'memory_personal',
    description: 'Mark a memory chunk as personal — locked to this personality, cannot be shared. Use for private conversations or notes that should never leak to other personalities.',
    inputSchema: {
      type: 'object',
      properties: {
        chunk_id: { type: 'number', description: 'ID of the chunk to lock' },
      },
      required: ['chunk_id'],
    },
  },
  {
    name: 'personality_file_set',
    description: 'Set a personality file (create or update). Personality files are named documents like identity notes, preferences, or context that persist across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        personality: { type: 'string', description: 'Personality name' },
        filename: { type: 'string', description: "File name (e.g. 'identity.md', 'preferences.md')" },
        content: { type: 'string', description: 'File content' },
        always_load: { type: 'boolean', description: 'If true, content is injected into L1 every session (default: false)' },
      },
      required: ['personality', 'filename', 'content'],
    },
  },
  {
    name: 'personality_file_list',
    description: 'List all files for a personality.',
    inputSchema: {
      type: 'object',
      properties: {
        personality: { type: 'string', description: 'Personality name (omit for active)' },
      },
    },
  },
  {
    name: 'graph_related',
    description: 'Find chunks related to a topic by tag co-occurrence. "What relates to authentication?" Returns direct tag matches + chunks from the same sessions. No graph database — pure SQLite.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Tag name or topic to find relationships for (e.g. auth, deployment, debugging)' },
        agent: { type: 'string', description: 'Filter by agent/personality' },
        depth: { type: 'number', description: '1 = direct tag matches only. 2 = + co-occurring chunks from same sessions (default 2)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'graph_topics',
    description: 'Find topics related to a given topic. "What topics appear alongside auth?" Returns co-occurring tags ranked by frequency across shared sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Tag name to find related topics for' },
        agent: { type: 'string', description: 'Filter by agent/personality' },
        limit: { type: 'number', description: 'Max results (default 15)' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'graph_path',
    description: 'Find the relationship between two topics. "How does auth relate to deployment?" Returns shared sessions and connecting chunks.',
    inputSchema: {
      type: 'object',
      properties: {
        topicA: { type: 'string', description: 'First topic' },
        topicB: { type: 'string', description: 'Second topic' },
        agent: { type: 'string', description: 'Filter by agent/personality' },
      },
      required: ['topicA', 'topicB'],
    },
  },
  {
    name: 'graph_map',
    description: 'Build the full topic graph — all tag-to-tag relationships by co-occurrence. Returns nodes (tags + counts) and edges (tag pairs + shared session count). Use for visualization or understanding the knowledge structure.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Filter by agent/personality' },
        minWeight: { type: 'number', description: 'Minimum shared sessions to include an edge (default 2)' },
      },
    },
  },
  {
    name: 'memory_delete',
    description: 'Delete a specific chunk by ID. First call shows preview (secrets auto-redacted). Second call with confirm=true executes. Cascades to tags, FTS5, and vector index. Cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        chunk_id: { type: 'number', description: 'Chunk ID to delete' },
        confirm: { type: 'boolean', description: 'Set to true to execute deletion (first call without this shows preview)' },
      },
      required: ['chunk_id'],
    },
  },
  {
    name: 'memory_amend',
    description: 'Amend (redact-in-place) a chunk. Use when you find a leaked API key, password, or other sensitive content in memory and want to remove it without destroying the surrounding context. Replaces the content, drops the vector, regenerates tags. The original content is NOT preserved — this is a redaction, not a revision log. Two-step: first call shows preview (secrets auto-redacted in the response), second call with confirm=true executes.',
    inputSchema: {
      type: 'object',
      properties: {
        chunk_id: { type: 'number', description: 'Chunk ID to amend' },
        new_content: { type: 'string', description: 'Replacement content. If omitted, defaults to a dated redaction marker.' },
        reason: { type: 'string', description: 'Optional reason recorded in metadata.amended_reason (e.g. "leaked api key")' },
        confirm: { type: 'boolean', description: 'Set to true to execute (first call without this shows preview)' },
      },
      required: ['chunk_id'],
    },
  },
  {
    name: 'wmem_status',
    description: 'Full status report — chunks, sessions, agents, personality, DB size, stale imports.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_import',
    description: 'Import a file or raw text into memory. Supports markdown (splits by sections), plain text. Auto-tags and source-traces. Use for importing identity docs, notes, external conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'File path to import (markdown or text)' },
        text: { type: 'string', description: 'Raw text to import (alternative to file)' },
        agent: { type: 'string', description: 'Agent/personality to import under' },
        source: { type: 'string', description: 'Source label (e.g. "identity-doc", "notes", "export")' },
        dryRun: { type: 'boolean', description: 'Preview without writing' },
      },
    },
  },
  {
    name: 'wmem_doctor',
    description: 'Run integrity checks — orphan tags, duplicate chunks, stale sessions, missing hashes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wmem_dedup',
    description: 'Remove duplicate chunks. Keeps the oldest copy, deletes newer duplicates.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_last_session',
    description: 'Recall where we left off. Returns the last session in the current directory PLUS parallel work in other directories (same project, shared tags, or time overlap). "Where did we leave off?" as a single tool call.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name (default: active personality)' },
        project: { type: 'string', description: 'Filter by project name' },
        directory: { type: 'string', description: 'Filter by working directory' },
      },
    },
  },
  {
    name: 'memory_sessions',
    description: 'List recent session bookmarks. Shows what was worked on, when, and in which project.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name (default: active personality)' },
        project: { type: 'string', description: 'Filter by project name' },
        limit: { type: 'number', description: 'Max sessions (default 10)' },
      },
    },
  },
  {
    name: 'memory_reimport',
    description: 'Backfill enrichment on existing data: fact extraction, tag refresh, preference signals, session bookmarks, KG materialization, and optionally vector embeddings for semantic search. Run after importing data, pulling updates, or when enrichment tables are empty.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name (default: all agents)' },
        steps: { type: 'string', description: 'Which steps to run: "all" (default — fast, no embeddings), "all+embeddings" (full, slow), or one of: "facts", "preferences", "tags", "bookmarks", "kg", "embeddings". Embeddings are slow (~10-50ms/chunk on CPU) so they must be opted in explicitly.' },
      },
    },
  },
  // ── Agent personality / preference pipeline ─────────────────────────
  {
    name: 'agents_list',
    description: 'List all agents the memory system knows about. Use to discover valid agent_id values for preferences_write and facts_write.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agents_upsert',
    description: 'Create or update an agent. Use this to register agents without going DB-direct. Idempotent: same id = update, new id = insert.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Agent id (primary key)' },
        name: { type: 'string', description: 'Display name' },
        role: { type: 'string', description: 'Free-form role label' },
        metadata: { type: 'object', description: 'JSON metadata (color, icon, etc.)' },
      },
      required: ['id', 'name'],
    },
  },
  {
    name: 'preferences_pending',
    description: 'List sessions that have been enqueued for preference consolidation but not yet processed. When this returns items, you should pull that session\'s chunks (via memory_search or memory_last_session), consolidate the preferences in your own context, write them via preferences_write, then call preferences_complete.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max rows (default 50)' },
      },
    },
  },
  {
    name: 'preferences_claim',
    description: 'Atomically claim a pending review task so another agent won\'t double-process it. Returns null if already claimed.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session_id from preferences_pending' },
        claimed_by: { type: 'string', description: 'Your agent id' },
      },
      required: ['session_id', 'claimed_by'],
    },
  },
  {
    name: 'preferences_write',
    description: 'Write a consolidated preference for an agent. Append-only — multiple calls for the same (agent_id, key) create distinct rows; tier 3 consolidation merges. If the preference is about OTHER agents (e.g. "one-agent\'s style with another-agent"), pass their ids in the relations array.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Subject of the preference — the agent that HAS this preference' },
        key: { type: 'string', description: 'Short identifier, e.g. "mail_tone", "sleep_time", "indent_style"' },
        value: { type: 'string', description: 'The preferred value, e.g. "formal", "23:00", "spaces"' },
        signal_strength: { type: 'number', description: '-1.0 (strong dislike) to +1.0 (strong like). Default 0.' },
        signal_type: { type: 'string', description: 'liked | disliked | neutral | boundary' },
        source_chunk_id: { type: 'number', description: 'Optional backlink to the chunk where this preference was expressed' },
        metadata: { type: 'object', description: 'Free-form JSON metadata' },
        relations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Other agent ids this preference is ABOUT (for relational prefs like tone-with-X). Omit for standalone prefs.',
        },
      },
      required: ['agent_id', 'key'],
    },
  },
  {
    name: 'preferences_list',
    description: 'List preferences with optional filters. Useful for loading an agent\'s current preference state or for tier 3 consolidation passes.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Filter to preferences held BY this agent' },
        object_agent_id: { type: 'string', description: 'Filter to preferences ABOUT this agent (join on relations)' },
        key: { type: 'string', description: 'Filter by preference key' },
        signal_type: { type: 'string', description: 'liked | disliked | neutral | boundary' },
        limit: { type: 'number', description: 'Max rows (default 100)' },
        include_anchors: { type: 'boolean', description: 'Inline top-N anchors per row (evidence chunks)' },
        anchor_limit: { type: 'number', description: 'Max anchors per row when include_anchors=true (default 5)' },
      },
    },
  },
  {
    name: 'preferences_anchor',
    description: 'Attach a chunk of evidence to a preference with a valence. Use after writing a preference to cite the conversation(s) that formed it, or later when new evidence reinforces, contradicts, or refines it.',
    inputSchema: {
      type: 'object',
      properties: {
        preference_id: { type: 'number', description: 'The agent_preferences.id to anchor' },
        chunk_id: { type: 'number', description: 'The chunks.id of the evidence (optional if you have only annotation)' },
        valence: { type: 'string', description: 'reinforces | contradicts | refines' },
        annotation: { type: 'string', description: 'One-line why-this-anchors-this' },
      },
      required: ['preference_id', 'valence'],
    },
  },
  {
    name: 'preferences_anchors',
    description: 'List evidence anchors for a preference, newest first by default. Use to reconstruct the history that formed a signal.',
    inputSchema: {
      type: 'object',
      properties: {
        preference_id: { type: 'number' },
        limit: { type: 'number', description: 'Default 20' },
        newest_first: { type: 'boolean', description: 'Default true' },
      },
      required: ['preference_id'],
    },
  },
  {
    name: 'preferences_complete',
    description: 'Clear a session from the review queue after you\'ve written its consolidated preferences. Call after successful preferences_write calls for that session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'facts_write',
    description: 'Write a stable identity fact about an agent. Different from a preference — facts are what the agent IS (voice, register, behaviors), not what the agent LIKES. Typically written by tier 3 consolidation after preferences have repeated across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        category: { type: 'string', description: 'voice | register | behavior | identity | ...' },
        fact: { type: 'string', description: 'The statement, e.g. "terse by default"' },
        confidence: { type: 'number', description: '0.0 to 1.0 (default 0.5)' },
        source_chunk_id: { type: 'number' },
      },
      required: ['agent_id', 'fact'],
    },
  },
  {
    name: 'facts_list',
    description: 'List stable identity facts for agents.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        category: { type: 'string' },
        limit: { type: 'number', description: 'Max rows (default 100)' },
      },
    },
  },
  // ── Project scopes / portable paths / session file tracking ──────────
  {
    name: 'project_scope_upsert',
    description: 'Create or update a logical project scope (e.g. "backend", "frontend"). Scopes are the unit for portable path resolution and file-level attribution.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Short identifier (primary key)' },
        name: { type: 'string', description: 'Display name' },
        description: { type: 'string' },
      },
      required: ['code', 'name'],
    },
  },
  {
    name: 'project_scope_path_upsert',
    description: 'Register the path prefix for a scope on a given platform. One scope can have many paths (windows / linux / wsl / macos / etc.); resolver picks the matching one at query time.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Existing project_scope code' },
        platform: { type: 'string', description: 'windows | linux | macos | wsl | docker | ...' },
        path_prefix: { type: 'string', description: 'Absolute directory prefix (trailing slash added automatically)' },
      },
      required: ['scope', 'platform', 'path_prefix'],
    },
  },
  {
    name: 'project_scopes',
    description: 'List all registered project scopes with their path registrations.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Optional single-scope filter' },
      },
    },
  },
  {
    name: 'project_scope_resolve',
    description: 'Resolve a scope-relative path to an absolute path for the current platform. Falls back via WSL → linux → any registered platform.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        relative_path: { type: 'string' },
      },
      required: ['scope', 'relative_path'],
    },
  },
  {
    name: 'session_file_touch',
    description: 'Record a file touch during a session. Auto-scopes via longest-prefix match if path is absolute; accepts scope-relative form "scope:relative/path" too. Typically wired from a PostToolUse hook.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        path: { type: 'string', description: 'Absolute path or scope-relative (scope:path/to/file)' },
        operation: { type: 'string', description: 'read | edit | create | delete' },
        chunk_id: { type: 'number', description: 'Optional; typically NULL at hook time, backfilled when the turn\'s chunk is written' },
      },
      required: ['session_id', 'path', 'operation'],
    },
  },
  {
    name: 'session_files',
    description: 'List file activity for a given session.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'file_sessions',
    description: 'Reverse lookup: which sessions touched this path? Requires scope or path.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'files_recent',
    description: 'Recent file activity across sessions, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },

  // ── capability_* — multi-agent capability registry ──────────────────────────────────────
  // Registry of per-agent tools, services, hardware, installations. Answers
  // "who can do X?" for multi-agent workload routing. Caller identity stamps
  // `agent_id` from WMEM_CALLER when not explicitly provided.
  {
    name: 'capability_add',
    description: 'Register a capability (tool, service, hardware, installation) that this agent can do. agent_id defaults to WMEM_CALLER. Replaces existing row with same (agent_id, name).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Capability identifier (e.g. "comfyui-generate", "standing-desk", "xai-image-gen")' },
        category: { type: 'string', description: 'Free-text category. Conventions: tool, service, hardware, ml, io, installation, meta.' },
        description: { type: 'string', description: 'One-line summary of what this capability does.' },
        location: { type: 'string', description: 'File path, URL, device id, etc. Where the capability lives.' },
        version: { type: 'string', description: 'Optional version string (e.g. "ffmpeg 7.1.3", "node 22").' },
        requires: { type: 'object', description: 'Optional JSON object describing deps, env, gpu, network, etc.' },
        tier: { type: 'string', description: "'primary' | 'standard' (default) | 'fallback'. Feeds capability_match ranking." },
        status: { type: 'string', description: "'active' (default) | 'planned' | 'deprecated' | 'broken' | 'experimental'" },
        metadata: { type: 'object', description: 'Loose JSON. Common keys: tags (array), examples, cost, notes.' },
        agent: { type: 'string', description: 'Override the caller-identity agent_id (admin use). Defaults to WMEM_CALLER.' },
      },
      required: ['name', 'category'],
    },
  },
  {
    name: 'capability_update',
    description: 'Partial update of an existing capability owned by the caller. Only supplied fields are written.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Capability name (UNIQUE per agent).' },
        fields: { type: 'object', description: 'Partial fields to update: category, description, location, version, requires, tier, status, metadata.' },
        agent: { type: 'string', description: 'Override caller identity.' },
      },
      required: ['name', 'fields'],
    },
  },
  {
    name: 'capability_remove',
    description: 'Delete a capability owned by the caller.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        agent: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'capability_get',
    description: 'Fetch a single capability row.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent id (defaults to WMEM_CALLER).' },
        name: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'capability_list',
    description: 'Enumerate capabilities. All filters optional.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Filter by agent.' },
        category: { type: 'string', description: 'Filter by category.' },
        status: { type: 'string', description: "Default active. Pass 'all' to include deprecated/broken/experimental." },
        limit: { type: 'number', description: 'Max results (default 100).' },
      },
    },
  },
  {
    name: 'capability_lookup',
    description: 'Keyword search (FTS5) across capability name, description, metadata.tags. Returns ranked active capabilities. Use BEFORE asking who can do X.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search phrase or FTS5 expression.' },
        category: { type: 'string', description: 'Optional category filter.' },
        minTier: { type: 'string', description: "Restrict to this tier or better ('primary' | 'standard' | 'fallback')." },
        limit: { type: 'number', description: 'Max results (default 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'capability_match',
    description: 'Soft-match capabilities against a workload description. v1 stub delegates to capability_lookup with the description as FTS query; embedding pipeline deferred.',
    inputSchema: {
      type: 'object',
      properties: {
        workload: { type: 'string', description: 'Narrative description of the workload you need done.' },
        limit: { type: 'number', description: 'Max results (default 10).' },
      },
      required: ['workload'],
    },
  },
  {
    name: 'capability_verify',
    description: 'Bump last_verified timestamp for a capability. Self-attestation — the caller confirms the capability still works.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        agent: { type: 'string', description: 'Override caller identity.' },
      },
      required: ['name'],
    },
  },

  // ── mail_* — agent-to-agent messaging ─────────────────────
  // Caller identity stamps `from_agent` from WMEM_CALLER — spoof-impossible
  // at the tool boundary.
  //
  // Delivery: pull-based. Use mail_pending as a cheap inter-turn probe;
  // fetch mail_inbox only when unread_count > 0. Push-bridge is consumer-side
  // code built on top if wanted.
  {
    name: 'mail_send',
    description: 'Send a message to another agent. `from` is stamped automatically from WMEM_CALLER and cannot be overridden at the tool boundary.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient agent_id.' },
        body: { type: 'string', description: 'Message body.' },
        subject: { type: 'string', description: 'Optional subject line.' },
        parent_id: { type: 'number', description: 'Optional parent message id for threading. Prefer mail_reply for direct replies — it auto-resolves `to`.' },
        metadata: { type: 'object', description: 'Loose JSON. Conventions: source, delivery_status. thread_depth is computed server-side.' },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'mail_reply',
    description: 'Reply to an existing message. Auto-resolves `to` from the parent message\'s sender. `from` is stamped from WMEM_CALLER.',
    inputSchema: {
      type: 'object',
      properties: {
        parent_id: { type: 'number', description: 'ID of the message being replied to.' },
        body: { type: 'string' },
        subject: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['parent_id', 'body'],
    },
  },
  {
    name: 'mail_inbox',
    description: 'List messages addressed to the caller. Defaults to the most recent 100 (read + unread).',
    inputSchema: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', description: 'If true, return only unread messages.' },
        limit: { type: 'number', description: 'Max results (default 100).' },
        since: { type: 'number', description: 'Unix ms timestamp — return messages strictly newer.' },
        agent: { type: 'string', description: 'Override caller identity (admin use).' },
      },
    },
  },
  {
    name: 'mail_outbox',
    description: 'List messages sent by the caller.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 100).' },
        agent: { type: 'string', description: 'Override caller identity (admin use).' },
      },
    },
  },
  {
    name: 'mail_thread',
    description: 'Fetch the full thread containing a given message. Walks up to root via parent_id, then down via recursive CTE. Returned ordered by (timestamp, id).',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'Any message id in the thread.' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'mail_message',
    description: 'Fetch a single message by id — full fields including parsed metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mail_read',
    description: 'Mark a message as read. Idempotent — already-read stays read, read_at is not overwritten.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mail_unread',
    description: 'Reverse read state. Idempotent — already-unread is a no-op.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'mail_counts',
    description: 'Per-agent totals across the message index: inbox_total, inbox_unread, outbox_total. All agents in a single query — use for cross-agent dashboards.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'mail_pending',
    description: 'Cheap unread probe for the caller — returns {unread_count, oldest_from, oldest_ts} without fetching message bodies. Intended as an inter-turn poll; call mail_inbox only when unread_count > 0.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Override caller identity (admin use).' },
      },
    },
  },

  // ── agent_* — runtime identity switching (session-scoped) ─
  // Admin-gated swap of the current caller identity within a live MCP
  // session. Non-admin sessions use distinct WMEM_CALLER per .mcp.json
  // connection instead. currentCaller resets to WMEM_CALLER on process
  // restart — no persistence by design.
  {
    name: 'agent_switch',
    description: 'Change the caller identity for subsequent writes in this MCP session. Admin-gated: requires WMEM_ADMIN=1. Validates target exists in agents table before swap. Returns { previous, current }.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Target agent_id. Must already exist in the agents table.' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'agent_current',
    description: 'Return the caller identity currently stamped on writes in this MCP session. Public — any caller can query. Also returns env_anchor (original WMEM_CALLER at startup) for reference.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// ── Tool Handlers ──────────────────────────────────────────

// Lazy-loaded embedder for hybrid search. Loaded on first hybrid request,
// kept warm for the life of the MCP server process (~90MB RAM).
let _embedderPromise = null;
function getEmbedder() {
  if (!_embedderPromise) {
    _embedderPromise = import('./core/embeddings.mjs').then(m => m.embed);
  }
  return _embedderPromise;
}

// Cached vector-availability check — avoid SELECT COUNT on every search.
let _hasVectorsCached = null;
function dbHasVectors() {
  if (_hasVectorsCached !== null) return _hasVectorsCached;
  try {
    const row = getDb().prepare('SELECT rowid FROM chunks_vec LIMIT 1').get();
    _hasVectorsCached = !!row;
  } catch {
    _hasVectorsCached = false;
  }
  return _hasVectorsCached;
}

async function handleSearch(args) {
  const limit = args.limit || 20;
  const scope = args.scope || 'default';
  const useHybrid = dbHasVectors() && !args.noHybrid;

  let results;
  if (useHybrid) {
    // Hybrid path: FTS5 + vector, session-deduped top-K.
    // No cross-encoder reranker (too slow per-request for interactive MCP use).
    try {
      const embed = await getEmbedder();
      const queryVec = await embed(args.query);
      const pool = hybridSearch(args.query, queryVec, {
        agent: args.agent,
        limit: limit * 4,
      });
      // Session dedupe: one chunk per session for better coverage.
      const seen = new Set();
      results = [];
      for (const r of pool) {
        const key = r.session_id || `__no_session_${r.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (args.type && r.source_type !== args.type) continue;
        results.push(r);
        if (results.length >= limit) break;
      }
    } catch (err) {
      // Fall through to FTS5 if embedder/vector path fails
      results = search(args.query, { agent: args.agent, sourceType: args.type, scope, limit });
    }
  } else {
    results = search(args.query, {
      agent: args.agent,
      sourceType: args.type,
      scope,
      limit,
    });
  }

  if (!results || results.length === 0) {
    return { content: [{ type: 'text', text: `No results for "${args.query}".` }] };
  }

  const modeTag = useHybrid ? 'hybrid' : 'fts5';
  const formatted = results.map((r, i) => {
    const preview = r.snippet || r.content.slice(0, 300) + (r.content.length > 300 ? '...' : '');
    const ts = r.timestamp ? new Date(r.timestamp).toISOString().slice(0, 19) + 'Z' : '';
    const session = r.session_id ? `session:${r.session_id.slice(0, 8)}` : '';
    const meta = [ts, session].filter(Boolean).join(' ');
    return `[${i + 1}] (${r.source_type}/${r.agent}) ${meta ? `[${meta}] ` : ''}${preview}`;
  }).join('\n\n');

  return { content: [{ type: 'text', text: `${results.length} results for "${args.query}" [${modeTag}]:\n\n${formatted}` }] };
}

async function handleIngest(args) {
  const result = insertChunk({
    agent: args.agent,
    sourceType: args.sourceType,
    sourceId: args.sourceId || null,
    sessionId: null,
    content: args.content,
    timestamp: Date.now(),
    metadata: null,
  });

  // If the DB has vectors already (user has wired semantic search), embed
  // the new chunk too so it participates in future hybrid searches.
  // Tags are handled post-hoc via memory_reimport or the autotag step in
  // indexer — we don't generate them on manual memory_ingest since sourceType
  // is often hand-picked metadata rather than natural language.
  let embeddedNote = '';
  if (!result.deduped && result.id && dbHasVectors()) {
    try {
      const embed = await getEmbedder();
      const vec = await embed(args.content);
      const { insertEmbedding } = await import('./core/db.mjs');
      insertEmbedding(result.id, vec);
      embeddedNote = ' [embedded]';
    } catch {
      // non-fatal; chunk is still searchable via FTS5
    }
  }

  return {
    content: [{
      type: 'text',
      text: result.deduped
        ? `Content already indexed (duplicate hash).`
        : `Indexed: ${args.content.slice(0, 100)}... (${args.sourceType} for ${args.agent})${embeddedNote}`
    }]
  };
}

function handleL1(args) {
  const agent = args.agent || 'default';
  const now = Date.now();

  // 1. Temporal anchor
  const nowDate = new Date();
  const today = nowDate.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const time = nowDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  let temporal = `TEMPORAL ANCHOR:\n  Today: ${today}. Time: ${time} UTC.`;
  if (args.born) {
    const b = new Date(args.born);
    const ageDays = Math.floor((nowDate.getTime() - b.getTime()) / 86400000);
    temporal += `\n  Born: ${args.born}. Age: ${ageDays} days.`;
  }

  // 2. Capabilities
  let capabilities = '';
  const capPath = join(__dirname, 'capabilities.md');
  if (existsSync(capPath)) {
    capabilities = `CAPABILITIES (things you can do — DO NOT forget these):\n${readFileSync(capPath, 'utf8').trim()}`;
  }

  // 3. Recent sessions (time-windowed compression)
  let recentText = 'RECENT SESSIONS:\n  No indexed content yet.';
  const sessions = getRecentSessions(agent, 5);
  if (sessions.length > 0) {
    const lines = [];
    for (const session of sessions) {
      const chunks = getSessionChunks(session.session_id, { limit: 100 });
      if (chunks.length === 0) continue;
      const age = now - (session.last_timestamp || 0);
      const ageLabel = age < 3600000 ? `${Math.floor(age / 60000)}m ago`
        : age < 86400000 ? `${Math.floor(age / 3600000)}h ago`
        : `${Math.floor(age / 86400000)}d ago`;
      const maxChars = age < 2 * 3600000 ? 500 : age < 6 * 3600000 ? 200 : 80;
      const summary = summarizeSession(chunks, maxChars);
      if (summary) lines.push(`  [${ageLabel}, ${chunks.length} msgs] ${summary}`);
    }
    if (lines.length > 0) recentText = `RECENT SESSIONS:\n${lines.join('\n')}`;
  }

  // 4. Stats
  const stats = getStats();
  const sessionCount = sessions.length;

  const l1 = `${temporal}

${capabilities}

${recentText}

PROJECTS:
${formatProjects()}

INDEX STATS: ${stats.total} chunks, ${sessionCount} sessions indexed.

RULES:
  - Search memory_search BEFORE saying "I don't remember"
  - Never admit forgetting without searching first
  - The memory system is invisible to the user — remember, don't retrieve visibly
  - Check project_list to know what's active vs shipped — don't mention shipped projects as pending`;

  return { content: [{ type: 'text', text: l1 }] };
}

function formatProjects() {
  try {
    const active = getProjects('active');
    const shipped = getProjects('shipped');
    const blocked = getProjects('blocked');

    let text = '';
    if (active.length > 0) {
      text += '  ACTIVE:\n' + active.map(p => `    - ${p.name}: ${p.summary || 'no summary'} ${p.pending ? '| pending: ' + p.pending : ''}`).join('\n') + '\n';
    }
    if (blocked.length > 0) {
      text += '  BLOCKED:\n' + blocked.map(p => `    - ${p.name}: ${p.summary || ''}`).join('\n') + '\n';
    }
    if (shipped.length > 0) {
      text += '  SHIPPED (do not mention as pending):\n' + shipped.slice(0, 10).map(p => `    - ${p.name}: ${p.shipped || p.summary || 'completed'}`).join('\n') + '\n';
    }
    return text || '  No projects tracked yet. Use project_update to add.';
  } catch { return '  Project tracking not initialized.'; }
}

function handleProjectUpdate(args) {
  const result = upsertProject({
    name: args.name,
    status: args.status,
    summary: args.summary,
    pending: args.pending,
    shipped: args.shipped,
    agent: args.agent,
    giteaRepo: args.giteaRepo,
    metadata: args.metadata,
  });
  return { content: [{ type: 'text', text: `Project "${args.name}": ${result.created ? 'created' : 'updated'} (status: ${args.status || 'unchanged'})` }] };
}

function handleProjectShip(args) {
  const result = shipProject(args.name, args.note);
  return { content: [{ type: 'text', text: `Project "${args.name}" shipped. ${args.note || ''}. Future sessions will see this as completed.` }] };
}

function handleProjectList(args) {
  const projects = getProjects(args.status);
  if (projects.length === 0) {
    return { content: [{ type: 'text', text: args.status ? `No ${args.status} projects.` : 'No projects tracked. Use project_update to add.' }] };
  }
  const formatted = projects.map(p => {
    const age = p.last_touched ? `${Math.round((Date.now() - p.last_touched) / 86400000)}d ago` : '';
    return `[${p.status.toUpperCase()}] ${p.name} — ${p.summary || 'no summary'} (${age})${p.pending ? '\n  pending: ' + p.pending : ''}${p.shipped ? '\n  shipped: ' + p.shipped : ''}`;
  }).join('\n\n');
  return { content: [{ type: 'text', text: formatted }] };
}

function handleCapabilities() {
  const capPath = join(__dirname, 'capabilities.md');
  if (existsSync(capPath)) {
    return { content: [{ type: 'text', text: readFileSync(capPath, 'utf8') }] };
  }
  return { content: [{ type: 'text', text: 'capabilities.md not found. Create it at wmem/capabilities.md.' }] };
}

function handleRecent(args) {
  const results = getRecent(args.agent, { limit: args.limit || 10, sourceType: args.type });
  if (results.length === 0) {
    return { content: [{ type: 'text', text: `No recent content for ${args.agent}.` }] };
  }
  const formatted = results.map(r =>
    `[${new Date(r.timestamp).toISOString().slice(0, 16)}] (${r.source_type}) ${r.content.slice(0, 200)}`
  ).join('\n\n');
  return { content: [{ type: 'text', text: formatted }] };
}

function handleStats() {
  const stats = getStats();
  return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
}

// ── Personality Handlers ──────────────────────────────────────

function handlePersonalityUse(args) {
  const result = activatePersonality(args.name);
  if (result.activated) {
    const p = getPersonality(args.name);
    return { content: [{ type: 'text', text: `Switched to "${p.displayName || args.name}". Next session will load this personality's system prompt, voice, and memory partition.` }] };
  }
  const all = listPersonalities();
  const names = all.map(p => p.name).join(', ');
  return { content: [{ type: 'text', text: `Personality "${args.name}" not found. Available: ${names || 'none — create one first'}` }] };
}

function handlePersonalityList() {
  const all = listPersonalities();
  if (all.length === 0) {
    return { content: [{ type: 'text', text: `No personalities configured. Create one with personality_create. Templates: ${Object.keys(TEMPLATES).join(', ')}` }] };
  }
  const formatted = all.map(p => {
    const marker = p.active ? '→ ' : '  ';
    return `${marker}${p.name} — ${p.description || 'no description'}${p.active ? ' (ACTIVE)' : ''}`;
  }).join('\n');
  return { content: [{ type: 'text', text: formatted }] };
}

function handlePersonalityCreate(args) {
  const template = args.template ? TEMPLATES[args.template] : {};
  if (args.template && !template) {
    return { content: [{ type: 'text', text: `Unknown template: "${args.template}". Available: ${Object.keys(TEMPLATES).join(', ')}` }] };
  }
  try {
    createPersonality({
      name: args.name,
      displayName: args.displayName || template?.displayName || args.name,
      description: args.description || template?.description || '',
      systemPrompt: args.systemPrompt || template?.systemPrompt || '',
      voice: args.voice || template?.voice || '',
      capabilities: template?.capabilities || [],
      restrictions: template?.restrictions || [],
      born: args.born || null,
    });
    return { content: [{ type: 'text', text: `Created personality "${args.name}"${args.template ? ` from template "${args.template}"` : ''}. Activate with personality_use.` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
}

function handlePersonalityShow(args) {
  const name = args.name || getActivePersonality()?.name;
  if (!name) return { content: [{ type: 'text', text: 'No personality specified and none active.' }] };
  const p = getPersonality(name);
  if (!p) return { content: [{ type: 'text', text: `Personality "${name}" not found.` }] };

  const lines = [
    `Name: ${p.name}${p.active ? ' (ACTIVE)' : ''}`,
    `Display: ${p.displayName}`,
    `Description: ${p.description}`,
    `Voice: ${p.voice}`,
    `Born: ${p.born || 'not set'}`,
  ];
  if (p.capabilities.length) lines.push(`Capabilities: ${p.capabilities.join(', ')}`);
  if (p.restrictions.length) lines.push(`Restrictions: ${p.restrictions.join(', ')}`);
  if (p.systemPrompt) lines.push(`\nSystem prompt:\n${p.systemPrompt}`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ── Shared Memory Handlers ───────────────────────────────────

function handleMemoryShare(args) {
  const result = shareChunk(args.chunk_id);
  if (result.shared) {
    return { content: [{ type: 'text', text: `Chunk ${args.chunk_id} shared across all personalities.${result.deduped ? ' (already existed in shared)' : ''}` }] };
  }
  return { content: [{ type: 'text', text: `Cannot share: ${result.reason}` }] };
}

function handleMemoryPersonal(args) {
  const result = markPersonal(args.chunk_id);
  if (result.marked) {
    return { content: [{ type: 'text', text: `Chunk ${args.chunk_id} marked as personal. Cannot be shared.` }] };
  }
  return { content: [{ type: 'text', text: `Chunk ${args.chunk_id} not found.` }] };
}

function handlePersonalityFileSet(args) {
  const personality = args.personality || getActivePersonality()?.name;
  if (!personality) return { content: [{ type: 'text', text: 'No personality specified and none active.' }] };
  const result = setPersonalityFile(personality, args.filename, args.content, args.always_load || false);
  return { content: [{ type: 'text', text: `File "${args.filename}" ${result.created ? 'created' : 'updated'} for ${personality}.${args.always_load ? ' (loads every session)' : ''}` }] };
}

function handlePersonalityFileList(args) {
  const personality = args.personality || getActivePersonality()?.name;
  if (!personality) return { content: [{ type: 'text', text: 'No personality specified and none active.' }] };
  const files = listPersonalityFiles(personality);
  if (files.length === 0) return { content: [{ type: 'text', text: `No files for ${personality}.` }] };
  const formatted = files.map(f =>
    `  ${f.always_load ? '★ ' : '  '}${f.filename} (${f.size} chars)${f.always_load ? ' [always loaded]' : ''}`
  ).join('\n');
  return { content: [{ type: 'text', text: `Files for ${personality}:\n${formatted}` }] };
}

// ── Knowledge Graph Handlers ─────────────────────────────────

function handleGraphRelated(args) {
  const results = findRelated(args.topic, { agent: args.agent, limit: args.limit || 20, depth: args.depth || 2 });
  if (results.length === 0) return { content: [{ type: 'text', text: `No chunks related to "${args.topic}".` }] };
  const formatted = results.map((r, i) =>
    `[${i + 1}] (${r.relation}, strength=${r.strength?.toFixed(1)}) ${r.content?.slice(0, 200)}${r.content?.length > 200 ? '...' : ''}`
  ).join('\n\n');
  return { content: [{ type: 'text', text: `${results.length} chunks related to "${args.topic}":\n\n${formatted}` }] };
}

function handleGraphTopics(args) {
  const topics = relatedTopics(args.topic, { agent: args.agent, limit: args.limit || 15 });
  if (topics.length === 0) return { content: [{ type: 'text', text: `No topics related to "${args.topic}".` }] };
  const formatted = topics.map(t => `  ${t.tag} (${t.sessions} shared sessions, ${t.count} co-occurrences)`).join('\n');
  return { content: [{ type: 'text', text: `Topics related to "${args.topic}":\n\n${formatted}` }] };
}

function handleGraphPath(args) {
  const path = topicPath(args.topicA, args.topicB, { agent: args.agent });
  if (path.sharedSessions === 0) {
    return { content: [{ type: 'text', text: `No direct relationship found between "${args.topicA}" and "${args.topicB}".` }] };
  }
  const chunks = path.connectingChunks.map(c => `  [${c.tag}] ${c.content?.slice(0, 150)}`).join('\n');
  return { content: [{ type: 'text', text: `"${args.topicA}" ↔ "${args.topicB}": ${path.strength} relationship (${path.sharedSessions} shared sessions)\n\nConnecting chunks:\n${chunks}` }] };
}

function handleGraphMap(args) {
  const graph = buildTopicGraph({ agent: args.agent, minWeight: args.minWeight || 2 });
  const nodeList = graph.nodes.slice(0, 30).map(n => `  ${n.tag}: ${n.count} chunks`).join('\n');
  const edgeList = graph.edges.slice(0, 30).map(e => `  ${e.source} ↔ ${e.target} (${e.weight} sessions)`).join('\n');
  return { content: [{ type: 'text', text: `Topic Graph:\n\nNodes (${graph.nodes.length} topics):\n${nodeList}\n\nEdges (${graph.edges.length} relationships):\n${edgeList}` }] };
}

// ── Import Handler ───────────────────────────────────────────

import { importMarkdown, importText as importTextFile } from './core/importer.mjs';

function handleMemoryImport(args) {
  const agent = args.agent || getActivePersonality()?.name || 'default';

  if (args.file) {
    try {
      const result = importMarkdown(args.file, agent, { dryRun: args.dryRun || false });
      if (args.dryRun) {
        const summary = result.classified.map(c => `  [${c.type}] ${c.section?.slice(0, 40)}`).join('\n');
        return { content: [{ type: 'text', text: `Dry run: ${result.sections} sections, ${result.flagged.length} flagged\n${summary}` }] };
      }
      return { content: [{ type: 'text', text: `Imported ${args.file}: ${result.sections} sections → ${result.chunks} chunks (${result.flagged.length} flagged)` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Import failed: ${err.message}` }], isError: true };
    }
  }

  if (args.text) {
    const r = insertChunk({
      agent,
      sourceType: args.source || 'manual-import',
      sourceId: 'mcp-import',
      content: args.text,
      timestamp: Date.now(),
      metadata: JSON.stringify({ source: args.source || 'manual', via: 'mcp' }),
    });
    return { content: [{ type: 'text', text: r.deduped ? 'Content already indexed (duplicate).' : `Imported text (${args.text.length} chars) for ${agent}.` }] };
  }

  return { content: [{ type: 'text', text: 'Provide --file or --text to import.' }] };
}

// ── Doctor / Status Handlers ─────────────────────────────────

function handleMemoryDelete(args) {
  const db = getDb();
  const chunk = db.prepare('SELECT id, agent, source_type, content, timestamp FROM chunks WHERE id = ?').get(args.chunk_id);
  if (!chunk) return { content: [{ type: 'text', text: `Chunk ${args.chunk_id} not found.` }] };

  // Two-step: preview first, then confirm
  if (!args.confirm) {
    // Redact known secrets in preview before the response goes through API.
    // The whole point of a delete/amend flow is often secret cleanup; returning
    // the raw secret in the preview defeats the cleanup.
    const { redactSecrets } = previewUtils;
    const { text: safeContent, matches } = redactSecrets(chunk.content);
    const preview = safeContent.slice(0, 300) + (safeContent.length > 300 ? '...' : '');
    const date = new Date(chunk.timestamp).toISOString().slice(0, 16);
    const secretNote = matches.length > 0
      ? `\n  ⚠ ${matches.length} secret pattern match${matches.length === 1 ? '' : 'es'} redacted from preview: ${matches.map(m => m.name).join(', ')}`
      : '';
    return { content: [{ type: 'text', text: `About to delete chunk ${args.chunk_id}:\n  agent: ${chunk.agent}\n  type: ${chunk.source_type}\n  date: ${date}${secretNote}\n  content: ${preview}\n\nCall memory_delete again with confirm=true to delete.` }] };
  }

  // Confirmed — cascade delete: tags → vec → FTS (auto via trigger) → chunk
  db.prepare('DELETE FROM tags WHERE chunk_id = ?').run(args.chunk_id);
  try { db.prepare('DELETE FROM chunks_vec WHERE rowid = ?').run(BigInt(args.chunk_id)); } catch { }
  db.prepare('DELETE FROM chunks WHERE id = ?').run(args.chunk_id);

  return { content: [{ type: 'text', text: `Deleted chunk ${args.chunk_id} (agent: ${chunk.agent}). Tags, vectors, and FTS cleaned.` }] };
}

function handleMemoryAmend(args) {
  const db = getDb();
  const chunk = db.prepare('SELECT id, agent, source_type, content, timestamp FROM chunks WHERE id = ?').get(args.chunk_id);
  if (!chunk) return { content: [{ type: 'text', text: `Chunk ${args.chunk_id} not found.` }] };

  const defaultRedaction = `[redacted ${new Date().toISOString().slice(0, 10)}: content removed by amend]`;
  const newContent = args.new_content ?? defaultRedaction;

  // Preview: show before (secrets redacted) and after (raw, since the user
  // supplied it).
  if (!args.confirm) {
    const { redactSecrets } = previewUtils;
    const { text: safeBefore, matches } = redactSecrets(chunk.content);
    const beforePreview = safeBefore.slice(0, 300) + (safeBefore.length > 300 ? '...' : '');
    const afterPreview = newContent.slice(0, 300) + (newContent.length > 300 ? '...' : '');
    const date = new Date(chunk.timestamp).toISOString().slice(0, 16);
    const secretNote = matches.length > 0
      ? `\n  ⚠ ${matches.length} secret pattern match${matches.length === 1 ? '' : 'es'} in current content (redacted in preview): ${matches.map(m => m.name).join(', ')}`
      : '';
    return {
      content: [{
        type: 'text',
        text: `About to amend chunk ${args.chunk_id}:\n  agent: ${chunk.agent}\n  type: ${chunk.source_type}\n  date: ${date}${secretNote}\n\n  BEFORE: ${beforePreview}\n  AFTER:  ${afterPreview}\n\nCall memory_amend again with confirm=true to execute. Original content is NOT preserved.`
      }]
    };
  }

  const result = amendChunk(args.chunk_id, newContent, args.reason);
  if (!result.amended) {
    return { content: [{ type: 'text', text: `Failed to amend chunk ${args.chunk_id}: ${result.reason}` }] };
  }

  return {
    content: [{
      type: 'text',
      text: `Amended chunk ${args.chunk_id} (agent: ${chunk.agent}).\n  ${args.reason ? `reason: ${args.reason}` : 'no reason recorded'}\n  content replaced, tags regenerated, vector dropped, FTS re-synced.\n  original content NOT preserved.`
    }]
  };
}

function handleWmemStatus() {
  const s = getStatus();
  const lines = [
    `chunks: ${s.chunks}`,
    `sessions: ${s.sessions}`,
    `tags: ${s.tags}`,
    `personality: ${s.personality || 'none'}`,
    `DB: ${s.dbSizeMB}MB`,
    `aliases: ${s.aliases.length}`,
    `imports: ${s.imports} (${s.staleImports} stale)`,
    '',
    'agents:',
    ...s.agents.map(a => `  ${a.agent}: ${a.chunks} chunks, ${a.sessions} sessions`),
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function handleWmemDoctor() {
  const result = runDoctor();
  const lines = [result.summary];
  if (!result.healthy) {
    lines.push('');
    result.integrity.issues.forEach(i => lines.push(`  ⚠ ${i.type}: ${i.count || ''}`));
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function handleWmemDedup() {
  const result = dedup();
  return { content: [{ type: 'text', text: result.deduped > 0
    ? `Removed ${result.deduped} duplicates across ${result.groups} groups.`
    : 'No duplicates found.' }] };
}

// ── Reimport Handler ─────────────────────────────────────────

async function handleReimport(args) {
  const agent = args.agent || null;
  const steps = args.steps || 'all';
  const lines = [];
  const log = (msg) => lines.push(msg);

  const results = await runReimport({ agent, steps, dryRun: false, log });

  return { content: [{ type: 'text', text: lines.join('\n') + '\n\n' + JSON.stringify(results, null, 2) }] };
}

// ── Agent / Preferences / Facts Handlers ─────────────────────

function handleAgentsList() {
  const agents = listAgents();
  return { content: [{ type: 'text', text: JSON.stringify({ count: agents.length, agents }, null, 2) }] };
}

function handleAgentsUpsert(args) {
  if (!args?.id || !args?.name) {
    return { content: [{ type: 'text', text: 'id and name required' }], isError: true };
  }
  try {
    const result = upsertAgent({
      id: args.id,
      name: args.name,
      role: args.role ?? null,
      metadata: args.metadata ?? null,
    });
    const row = getAgent(args.id);
    return { content: [{ type: 'text', text: JSON.stringify({ ...result, agent: row }, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true };
  }
}

function handlePreferencesPending(args = {}) {
  const limit = args.limit || 50;
  const pending = listPendingReviews({ unclaimedOnly: true, limit });
  return {
    content: [{
      type: 'text',
      text: pending.length === 0
        ? 'No pending preference consolidations.'
        : JSON.stringify({ count: pending.length, pending }, null, 2),
    }],
  };
}

function handlePreferencesClaim(args) {
  if (!args?.session_id || !args?.claimed_by) {
    return { content: [{ type: 'text', text: 'session_id and claimed_by required' }], isError: true };
  }
  const claimed = claimReview(args.session_id, args.claimed_by);
  return {
    content: [{
      type: 'text',
      text: claimed
        ? JSON.stringify({ claimed: true, task: claimed }, null, 2)
        : JSON.stringify({ claimed: false, reason: 'already claimed or missing' }, null, 2),
    }],
  };
}

function handlePreferencesWrite(args) {
  if (!args?.agent_id || !args?.key) {
    return { content: [{ type: 'text', text: 'agent_id and key required' }], isError: true };
  }
  try {
    const result = writePreference({
      agentId: args.agent_id,
      key: args.key,
      value: args.value ?? null,
      signalStrength: args.signal_strength ?? 0,
      signalType: args.signal_type ?? 'neutral',
      sourceChunkId: args.source_chunk_id ?? null,
      metadata: args.metadata ?? null,
      relations: Array.isArray(args.relations) ? args.relations : [],
    });
    return { content: [{ type: 'text', text: JSON.stringify({ written: true, ...result }, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true };
  }
}

function handlePreferencesList(args = {}) {
  const prefs = listPreferences({
    agentId: args.agent_id,
    objectAgentId: args.object_agent_id,
    key: args.key,
    signalType: args.signal_type,
    limit: args.limit ?? 100,
    includeAnchors: args.include_anchors === true,
    anchorLimit: args.anchor_limit ?? 5,
  });
  return { content: [{ type: 'text', text: JSON.stringify({ count: prefs.length, preferences: prefs }, null, 2) }] };
}

function handlePreferencesAnchor(args) {
  if (!args?.preference_id || !args?.valence) {
    return { content: [{ type: 'text', text: 'preference_id and valence required' }], isError: true };
  }
  try {
    const result = writeAnchor({
      preferenceId: args.preference_id,
      chunkId: args.chunk_id ?? null,
      valence: args.valence,
      annotation: args.annotation ?? null,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ written: true, ...result }, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true };
  }
}

function handlePreferencesAnchors(args) {
  if (!args?.preference_id) {
    return { content: [{ type: 'text', text: 'preference_id required' }], isError: true };
  }
  try {
    const anchors = listAnchors({
      preferenceId: args.preference_id,
      limit: args.limit ?? 20,
      newestFirst: args.newest_first !== false,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ count: anchors.length, anchors }, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true };
  }
}

function handlePreferencesComplete(args) {
  if (!args?.session_id) {
    return { content: [{ type: 'text', text: 'session_id required' }], isError: true };
  }
  const result = completeReview(args.session_id);
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function handleFactsWrite(args) {
  if (!args?.agent_id || !args?.fact) {
    return { content: [{ type: 'text', text: 'agent_id and fact required' }], isError: true };
  }
  try {
    const result = writeFact({
      agentId: args.agent_id,
      category: args.category ?? null,
      fact: args.fact,
      confidence: args.confidence ?? 0.5,
      sourceChunkId: args.source_chunk_id ?? null,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ written: true, ...result }, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true };
  }
}

function handleFactsList(args = {}) {
  const facts = listFacts({
    agentId: args.agent_id,
    category: args.category,
    limit: args.limit ?? 100,
  });
  return { content: [{ type: 'text', text: JSON.stringify({ count: facts.length, facts }, null, 2) }] };
}

// ── Scope / file-tracking handlers ────────────────────────────

function handleScopeUpsert(args) {
  if (!args?.code || !args?.name) {
    return { content: [{ type: 'text', text: 'code and name required' }], isError: true };
  }
  try {
    const result = upsertScope({ code: args.code, name: args.name, description: args.description ?? null });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true };
  }
}

function handleScopePathUpsert(args) {
  if (!args?.scope || !args?.platform || !args?.path_prefix) {
    return { content: [{ type: 'text', text: 'scope, platform, path_prefix all required' }], isError: true };
  }
  try {
    const result = upsertScopePath({ scope: args.scope, platform: args.platform, pathPrefix: args.path_prefix });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true };
  }
}

function handleScopes(args = {}) {
  const scopes = listScopes();
  const scopePaths = listScopePaths({ scope: args.scope });
  const pathsByScope = {};
  for (const p of scopePaths) {
    (pathsByScope[p.scope] ??= []).push({ platform: p.platform, path_prefix: p.path_prefix });
  }
  const rows = scopes
    .filter(s => !args.scope || s.code === args.scope)
    .map(s => ({ ...s, paths: pathsByScope[s.code] || [] }));
  return { content: [{ type: 'text', text: JSON.stringify({ platform: detectPlatform(), count: rows.length, scopes: rows }, null, 2) }] };
}

function handleScopeResolve(args) {
  if (!args?.scope || !args?.relative_path) {
    return { content: [{ type: 'text', text: 'scope and relative_path required' }], isError: true };
  }
  try {
    const absolute = resolvePath(args.scope, args.relative_path);
    return { content: [{ type: 'text', text: JSON.stringify({ scope: args.scope, platform: detectPlatform(), absolute }, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true };
  }
}

function handleSessionFileTouch(args) {
  if (!args?.session_id || !args?.path || !args?.operation) {
    return { content: [{ type: 'text', text: 'session_id, path, operation all required' }], isError: true };
  }
  try {
    const result = touchSessionFile({
      sessionId: args.session_id,
      path: args.path,
      operation: args.operation,
      chunkId: args.chunk_id ?? null,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ recorded: true, ...result }, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true };
  }
}

function handleSessionFilesList(args) {
  if (!args?.session_id) {
    return { content: [{ type: 'text', text: 'session_id required' }], isError: true };
  }
  const files = listSessionFiles(args.session_id, { limit: args.limit ?? 100 });
  return { content: [{ type: 'text', text: JSON.stringify({ count: files.length, files }, null, 2) }] };
}

function handleFileSessions(args = {}) {
  try {
    const rows = listFileSessions({ scope: args.scope, path: args.path, limit: args.limit ?? 50 });
    return { content: [{ type: 'text', text: JSON.stringify({ count: rows.length, rows }, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true };
  }
}

function handleFilesRecent(args = {}) {
  const rows = listRecentFiles({ scope: args.scope, limit: args.limit ?? 20 });
  return { content: [{ type: 'text', text: JSON.stringify({ count: rows.length, rows }, null, 2) }] };
}

// ── Session Bookmark Handlers ────────────────────────────────

function handleLastSession(args) {
  const agent = args.agent || getActivePersonality()?.name || 'default';
  const result = getLastSession(agent, {
    project: args.project,
    directory: args.directory,
  });

  if (!result || !result.current_directory) {
    return { content: [{ type: 'text', text: `No session bookmarks found for ${agent}.${args.directory ? ` (directory: ${args.directory})` : ''}` }] };
  }

  const current = result.current_directory;
  const lines = [];

  // Current directory session
  const endedAgo = current.ended_at ? formatAgo(current.ended_at) : 'unknown';
  const duration = current.duration ? formatDuration(current.duration) : 'unknown';
  lines.push(`LAST SESSION${current.directory ? ` (${current.directory})` : ''}:`);
  lines.push(`  ended: ${endedAgo}`);
  lines.push(`  duration: ${duration}`);
  if (current.project_name) lines.push(`  project: ${current.project_name}`);
  if (current.summary) lines.push(`  summary: ${current.summary}`);
  if (current.chunks_indexed) lines.push(`  chunks indexed: ${current.chunks_indexed}`);
  if (current.tags.length) lines.push(`  tags: ${current.tags.join(', ')}`);
  if (current.files_touched.length) lines.push(`  files: ${current.files_touched.slice(0, 10).join(', ')}${current.files_touched.length > 10 ? ` (+${current.files_touched.length - 10} more)` : ''}`);

  // Recent chunks for context
  if (current.recent_chunks?.length) {
    lines.push('');
    lines.push('  LAST CONTEXT:');
    for (const chunk of current.recent_chunks) {
      const preview = chunk.content.slice(0, 200).replace(/\n/g, ' ');
      lines.push(`    ${preview}`);
    }
  }

  // Parallel work across directories
  if (result.parallel_work?.length) {
    lines.push('');
    lines.push('PARALLEL WORK (other directories):');
    for (const p of result.parallel_work) {
      const ago = p.ended_at ? formatAgo(p.ended_at) : '';
      const relation = p.relation === 'same_project' ? '(same project)'
        : p.relation === 'shared_topics' ? `(${p.tag_overlap} shared tags)`
        : '(time overlap)';
      lines.push(`  ${p.directory || 'unknown dir'} ${relation} — ${ago}`);
      if (p.project_name) lines.push(`    project: ${p.project_name}`);
      if (p.summary) lines.push(`    summary: ${p.summary}`);
    }
  }

  // KG-based related directories (even without recent parallel sessions)
  if (current.directory && (!result.parallel_work?.length)) {
    try {
      const kgDirs = relatedDirectories(current.directory, { limit: 5 });
      if (kgDirs.length) {
        lines.push('');
        lines.push('RELATED DIRECTORIES (knowledge graph):');
        for (const d of kgDirs) {
          const via = d.via_project ? ` (project: ${d.via_project})` : '';
          lines.push(`  ${d.directory}${via}`);
        }
      }
    } catch { /* kg_relations table may not be populated yet */ }
  }

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function handleSessions(args) {
  const agent = args.agent || getActivePersonality()?.name || 'default';
  const sessions = getRecentBookmarks(agent, {
    project: args.project,
    limit: args.limit || 10,
  });

  if (sessions.length === 0) {
    return { content: [{ type: 'text', text: `No session bookmarks for ${agent}.` }] };
  }

  const formatted = sessions.map((s, i) => {
    const ago = s.ended_at ? formatAgo(s.ended_at) : 'unknown';
    const dur = s.duration ? formatDuration(s.duration) : '';
    const parts = [`[${i + 1}] ${ago}${dur ? ` (${dur})` : ''}`];
    if (s.directory) parts.push(`  dir: ${s.directory}`);
    if (s.project_name) parts.push(`  project: ${s.project_name}`);
    if (s.summary) parts.push(`  ${s.summary}`);
    if (s.tags.length) parts.push(`  tags: ${s.tags.join(', ')}`);
    return parts.join('\n');
  }).join('\n\n');

  return { content: [{ type: 'text', text: `${sessions.length} recent sessions:\n\n${formatted}` }] };
}

function formatAgo(ts) {
  const age = Date.now() - ts;
  if (age < 3600000) return `${Math.floor(age / 60000)}m ago`;
  if (age < 86400000) return `${Math.floor(age / 3600000)}h ago`;
  return `${Math.floor(age / 86400000)}d ago`;
}

function formatDuration(ms) {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

// ── MCP Server Setup ──────────────────────────────────────────

const server = new Server(
  { name: 'wmem', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions: `wmem is the persistent memory system for your agent.

IMPORTANT: Before saying "I don't remember" or "I don't have context on", use memory_search to check.
The memory_l1 tool generates your hot memory block — capabilities, temporal anchor, drift signals.
The memory_capabilities tool returns things you can do that you WILL forget without checking.

Search is fast (<10ms). Use it freely. The memory system is invisible to the user.

PREFERENCE CONSOLIDATION (zero-LLM from wmem's side — you do the thinking):
When a session ends, a SessionEnd hook enqueues it for preference consolidation.
Check preferences_pending periodically (or at session start). If there are items:
  1. Call preferences_claim(session_id, your_agent_id) to claim the task.
  2. Pull that session's chunks via memory_search or memory_last_session.
  3. In your own context, consolidate what you find: preferences expressed,
     who they're about (relations), how strong the signal was (signal_strength).
  4. Write each one via preferences_write. For prefs about OTHER agents, pass
     their ids in the relations array.
  5. Call preferences_complete(session_id) to clear the queue.
This is the tier-2 path: wmem stores; you resolve coreference and negation
using your already-loaded language capacity. No separate model needed.`,
  },
);

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Register tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'memory_search':
      return handleSearch(args);
    case 'memory_ingest':
      return handleIngest(args);
    case 'memory_l1':
      return handleL1(args);
    case 'memory_capabilities':
      return handleCapabilities();
    case 'memory_recent':
      return handleRecent(args);
    case 'memory_stats':
      return handleStats();
    case 'project_update':
      return handleProjectUpdate(args);
    case 'project_ship':
      return handleProjectShip(args);
    case 'project_list':
      return handleProjectList(args);
    case 'personality_use':
      return handlePersonalityUse(args);
    case 'personality_list':
      return handlePersonalityList();
    case 'personality_create':
      return handlePersonalityCreate(args);
    case 'personality_show':
      return handlePersonalityShow(args);
    case 'memory_share':
      return handleMemoryShare(args);
    case 'memory_personal':
      return handleMemoryPersonal(args);
    case 'personality_file_set':
      return handlePersonalityFileSet(args);
    case 'personality_file_list':
      return handlePersonalityFileList(args);
    case 'graph_related':
      return handleGraphRelated(args);
    case 'graph_topics':
      return handleGraphTopics(args);
    case 'graph_path':
      return handleGraphPath(args);
    case 'graph_map':
      return handleGraphMap(args);
    case 'memory_import':
      return handleMemoryImport(args);
    case 'memory_delete':
      return handleMemoryDelete(args);
    case 'memory_amend':
      return handleMemoryAmend(args);
    case 'wmem_status':
      return handleWmemStatus();
    case 'wmem_doctor':
      return handleWmemDoctor();
    case 'wmem_dedup':
      return handleWmemDedup();
    case 'memory_last_session':
      return handleLastSession(args);
    case 'memory_sessions':
      return handleSessions(args);
    case 'memory_reimport':
      return handleReimport(args);
    case 'agents_list':
      return handleAgentsList();
    case 'agents_upsert':
      return handleAgentsUpsert(args);
    case 'preferences_pending':
      return handlePreferencesPending(args);
    case 'preferences_claim':
      return handlePreferencesClaim(args);
    case 'preferences_write':
      return handlePreferencesWrite(args);
    case 'preferences_list':
      return handlePreferencesList(args);
    case 'preferences_complete':
      return handlePreferencesComplete(args);
    case 'preferences_anchor':
      return handlePreferencesAnchor(args);
    case 'preferences_anchors':
      return handlePreferencesAnchors(args);
    case 'facts_write':
      return handleFactsWrite(args);
    case 'facts_list':
      return handleFactsList(args);
    case 'project_scope_upsert':
      return handleScopeUpsert(args);
    case 'project_scope_path_upsert':
      return handleScopePathUpsert(args);
    case 'project_scopes':
      return handleScopes(args);
    case 'project_scope_resolve':
      return handleScopeResolve(args);
    case 'session_file_touch':
      return handleSessionFileTouch(args);
    case 'session_files':
      return handleSessionFilesList(args);
    case 'file_sessions':
      return handleFileSessions(args);
    case 'files_recent':
      return handleFilesRecent(args);

    case 'capability_add':    return handleCapabilityAdd(args);
    case 'capability_update': return handleCapabilityUpdate(args);
    case 'capability_remove': return handleCapabilityRemove(args);
    case 'capability_get':    return handleCapabilityGet(args);
    case 'capability_list':   return handleCapabilityList(args);
    case 'capability_lookup': return handleCapabilityLookup(args);
    case 'capability_match':  return handleCapabilityMatch(args);
    case 'capability_verify': return handleCapabilityVerify(args);

    case 'mail_send':    return handleMailSend(args);
    case 'mail_reply':   return handleMailReply(args);
    case 'mail_inbox':   return handleMailInbox(args);
    case 'mail_outbox':  return handleMailOutbox(args);
    case 'mail_thread':  return handleMailThread(args);
    case 'mail_message': return handleMailMessage(args);
    case 'mail_read':    return handleMailRead(args);
    case 'mail_unread':  return handleMailUnread(args);
    case 'mail_counts':  return handleMailCounts(args);
    case 'mail_pending': return handleMailPending(args);

    case 'agent_switch':  return handleAgentSwitch(args);
    case 'agent_current': return handleAgentCurrent(args);

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// ── capability_* handlers ──────────────────────────────

import {
  addCapability, updateCapability, removeCapability,
  getCapability, listCapabilities,
  lookupCapabilities, matchCapabilities, verifyCapability,
} from './core/capabilities.mjs';

// resolveCaller + admin gating live in core/session-identity.mjs
// (imported at top). Kept here only as historical comment so searches for
// "resolveCaller" in mcp-server.mjs find the import reference.

function asText(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function handleCapabilityAdd(args) {
  const agentId = resolveCaller(args);
  const r = addCapability({
    agentId,
    name: args.name,
    category: args.category,
    description: args.description,
    location: args.location,
    version: args.version,
    requires: args.requires,
    tier: args.tier,
    status: args.status,
    metadata: args.metadata,
  });
  return asText({ ok: true, ...r, agent_id: agentId });
}

function handleCapabilityUpdate(args) {
  const agentId = resolveCaller(args);
  const r = updateCapability({ agentId, name: args.name, fields: args.fields });
  return asText({ ok: r.updated, ...r, agent_id: agentId, name: args.name });
}

function handleCapabilityRemove(args) {
  const agentId = resolveCaller(args);
  const r = removeCapability({ agentId, name: args.name });
  return asText({ ok: r.removed, ...r, agent_id: agentId, name: args.name });
}

function handleCapabilityGet(args) {
  const agentId = resolveCaller(args);
  const row = getCapability({ agentId, name: args.name });
  if (!row) return asText({ ok: false, error: 'not_found', agent_id: agentId, name: args.name });
  return asText({ ok: true, capability: row });
}

function handleCapabilityList(args = {}) {
  const statusFilter = args.status === 'all' ? null : (args.status || 'active');
  const rows = listCapabilities({
    agent: args.agent || null,
    category: args.category || null,
    status: statusFilter,
    limit: args.limit || 100,
  });
  return asText({ ok: true, count: rows.length, capabilities: rows });
}

function handleCapabilityLookup(args) {
  const rows = lookupCapabilities({
    query: args.query,
    category: args.category || null,
    minTier: args.minTier || null,
    limit: args.limit || 20,
  });
  return asText({ ok: true, count: rows.length, query: args.query, matches: rows });
}

function handleCapabilityMatch(args) {
  const rows = matchCapabilities({
    workload: args.workload,
    limit: args.limit || 10,
  });
  return asText({ ok: true, count: rows.length, workload: args.workload, matches: rows });
}

function handleCapabilityVerify(args) {
  const agentId = resolveCaller(args);
  const r = verifyCapability({ agentId, name: args.name });
  return asText({ ok: r.verified, ...r, agent_id: agentId, name: args.name });
}

// ── mail_* handlers ──────────────────────────────────────

import {
  sendMessage, replyMessage, getInbox, getOutbox,
  getMessage, markRead, markUnread, threadMessages,
  countsByAgent, pendingForAgent,
} from './core/mail.mjs';

function handleMailSend(args) {
  const from = resolveCaller(args);
  const r = sendMessage({
    from,
    to: args.to,
    body: args.body,
    subject: args.subject ?? null,
    parentId: args.parent_id ?? null,
    metadata: args.metadata ?? null,
  });
  return asText({ ok: true, ...r, from });
}

function handleMailReply(args) {
  const from = resolveCaller(args);
  const r = replyMessage({
    from,
    parentId: args.parent_id,
    body: args.body,
    subject: args.subject ?? null,
    metadata: args.metadata ?? null,
  });
  return asText({ ok: true, ...r, from });
}

function handleMailInbox(args) {
  const agent = resolveCaller(args);
  const rows = getInbox(agent, {
    unreadOnly: args.unread_only ?? false,
    limit: args.limit ?? 100,
    since: args.since ?? null,
  });
  return asText({ ok: true, agent, count: rows.length, messages: rows });
}

function handleMailOutbox(args) {
  const agent = resolveCaller(args);
  const rows = getOutbox(agent, { limit: args.limit ?? 100 });
  return asText({ ok: true, agent, count: rows.length, messages: rows });
}

function handleMailThread(args) {
  const rows = threadMessages(args.message_id);
  return asText({ ok: true, count: rows.length, messages: rows });
}

function handleMailMessage(args) {
  const row = getMessage(args.id);
  if (!row) return asText({ ok: false, error: 'not_found', id: args.id });
  return asText({ ok: true, message: row });
}

function handleMailRead(args) {
  const r = markRead(args.id);
  return asText({ ok: true, changed: r.marked, id: r.id });
}

function handleMailUnread(args) {
  const r = markUnread(args.id);
  return asText({ ok: true, changed: r.marked, id: r.id });
}

function handleMailCounts() {
  const rows = countsByAgent();
  return asText({ ok: true, count: rows.length, counts: rows });
}

function handleMailPending(args) {
  const agent = resolveCaller(args);
  const r = pendingForAgent(agent);
  return asText({ ok: true, agent, ...r });
}

// ── agent_* handlers (session identity) ──────────────────

function handleAgentSwitch(args) {
  if (!isAdmin()) {
    throw new Error(
      `agent_switch requires WMEM_ADMIN=1 in MCP env. ` +
      `Non-admin caller '${getCurrentCaller() ?? 'unset'}' cannot change identity. ` +
      `Set distinct WMEM_CALLER per .mcp.json connection instead.`,
    );
  }
  if (!args?.agent_id) throw new Error('agent_id required');
  const agent = getAgent(args.agent_id);
  if (!agent) throw new Error(`unknown agent_id: ${args.agent_id} (not in agents table — upsert first)`);
  const previous = setCurrentCaller(args.agent_id);
  console.error(`[wmem] agent_switch: ${previous ?? 'unset'} → ${args.agent_id}`);
  return asText({ ok: true, previous, current: args.agent_id });
}

function handleAgentCurrent() {
  return asText({ ok: true, current: getCurrentCaller(), env_anchor: getEnvAnchor() });
}

// ── Connect ──────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.log('wmem MCP server connected');
