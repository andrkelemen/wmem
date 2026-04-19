#!/usr/bin/env node
/**
 * session-end-enqueue — called by the SessionEnd hook after index-sessions
 * has processed any new chunks.
 *
 * Reads stdin JSON (Claude Code passes session metadata there) or accepts
 * --session-id, --agent, --chunk-count flags. Enqueues the session into
 * preference_review_queue so an in-session agent can consolidate preferences
 * the next time preferences_pending() is called.
 *
 * Silent success: logs one line to stderr, exits 0 regardless so the hook
 * can't block the session teardown.
 */

import { readFileSync } from 'fs';
import { enqueueReview } from '../core/agents.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session-id') out.sessionId = argv[++i];
    else if (a === '--agent') out.agent = argv[++i];
    else if (a === '--chunk-count') out.chunkCount = Number(argv[++i]);
  }
  return out;
}

function readStdinSync() {
  try {
    const data = readFileSync(0, 'utf8');
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

const flagArgs = parseArgs(process.argv.slice(2));
const stdinArgs = readStdinSync() || {};

const sessionId = flagArgs.sessionId || stdinArgs.session_id || stdinArgs.sessionId || process.env.CLAUDE_SESSION_ID;
if (!sessionId) {
  console.error('[session-end-enqueue] no session_id available, skipping');
  process.exit(0);
}

const agentId = flagArgs.agent || stdinArgs.agent || process.env.WMEM_AGENT || null;
const chunkCount = flagArgs.chunkCount ?? stdinArgs.chunk_count ?? null;

try {
  enqueueReview({ sessionId, agentId, chunkCount });
  console.error(`[session-end-enqueue] enqueued ${sessionId}${agentId ? ` (${agentId})` : ''}`);
} catch (err) {
  console.error(`[session-end-enqueue] failed: ${err.message}`);
}

process.exit(0);
