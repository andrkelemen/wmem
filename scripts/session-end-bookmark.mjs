#!/usr/bin/env node
/**
 * session-end-bookmark — called by the SessionEnd hook after index-sessions
 * has processed any new chunks.
 *
 * Records a session_bookmarks row capturing this session's existence + the
 * directory worked in, then materializes topic + directory relations in the
 * knowledge graph so cross-session/cross-folder pickup queries have current
 * data on next session-start.
 *
 * Reads stdin JSON (Claude Code session metadata) or accepts --session-id,
 * --agent, --directory flags. Silent success: logs one line to stderr,
 * always exits 0 so the hook can't block session teardown.
 *
 * Cost: bookmark insert is O(1). Materialization scans the tags table —
 * with low thousands of chunks it's <100ms; with tens of thousands it
 * could be 1-2s. Acceptable for session-end (off the critical path).
 * Set WMEM_SKIP_KG=1 to skip materialization on slow machines.
 */

import { readFileSync } from 'fs';
import { upsertBookmark, materializeTopicRelations, materializeDirectoryRelations } from '../core/db.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session-id') out.sessionId = argv[++i];
    else if (a === '--agent') out.agent = argv[++i];
    else if (a === '--directory') out.directory = argv[++i];
    else if (a === '--started-at') out.startedAt = Number(argv[++i]);
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

const sessionId = flagArgs.sessionId
  ?? stdinArgs.session_id ?? stdinArgs.sessionId
  ?? process.env.CLAUDE_SESSION_ID;

if (!sessionId) {
  console.error('[session-end-bookmark] no session_id available, skipping');
  process.exit(0);
}

const agent = flagArgs.agent
  ?? stdinArgs.agent
  ?? process.env.WMEM_AGENT
  ?? 'default';

const directory = flagArgs.directory
  ?? stdinArgs.cwd ?? stdinArgs.directory
  ?? process.env.PWD
  ?? process.cwd();

const startedAt = flagArgs.startedAt ?? stdinArgs.started_at ?? null;
const endedAt = Date.now();

try {
  const r = upsertBookmark({ sessionId, agent, directory, startedAt, endedAt });
  console.error(`[session-end-bookmark] bookmarked ${sessionId} (${agent}) in ${directory}${r.project ? ` [${r.project}]` : ''}`);
} catch (err) {
  console.error(`[session-end-bookmark] bookmark failed: ${err.message}`);
}

if (process.env.WMEM_SKIP_KG !== '1') {
  try {
    const t0 = Date.now();
    const topic = materializeTopicRelations();
    const dir   = materializeDirectoryRelations();
    const ms    = Date.now() - t0;
    const topicCount = typeof topic === 'object' ? (topic.edges ?? topic.inserted ?? topic.count ?? '?') : topic;
    const dirCount   = typeof dir   === 'object' ? (dir.edges   ?? dir.inserted   ?? dir.count   ?? '?') : dir;
    console.error(`[session-end-bookmark] kg: topic_edges=${topicCount} dir_edges=${dirCount} (${ms}ms)`);
  } catch (err) {
    console.error(`[session-end-bookmark] kg materialize failed: ${err.message}`);
  }
}

process.exit(0);
