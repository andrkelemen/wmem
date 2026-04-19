#!/usr/bin/env node
/**
 * posttooluse-record-file.mjs — Claude Code PostToolUse hook.
 *
 * Reads the JSON payload on stdin, extracts file_path and session_id,
 * records a session_files row. Silent success: exits 0 regardless so the
 * hook never blocks the tool call.
 *
 * Expected stdin shape (Claude Code's PostToolUse):
 *   { "session_id": "...", "tool_name": "Edit", "tool_input": { "file_path": "..." } }
 *
 * Tool → operation mapping:
 *   Read                → 'read'
 *   Edit | MultiEdit    → 'edit'
 *   Write               → 'create' if path didn't exist before, else 'edit'
 *   NotebookEdit        → 'edit'
 *   (others ignored)
 */

import { readFileSync, existsSync } from 'fs';
import { touchSessionFile } from '../core/scopes.mjs';

function readStdin() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch { return {}; }
}

const payload = readStdin();
const sessionId = payload.session_id || process.env.CLAUDE_SESSION_ID;
const toolName = payload.tool_name;
const filePath = payload.tool_input?.file_path
                 || payload.tool_input?.path
                 || payload.tool_input?.notebook_path;

if (!sessionId || !toolName || !filePath) {
  // Not our kind of tool call, or missing data. Silent exit.
  process.exit(0);
}

let operation;
switch (toolName) {
  case 'Read':
    operation = 'read';
    break;
  case 'Edit':
  case 'MultiEdit':
  case 'NotebookEdit':
    operation = 'edit';
    break;
  case 'Write':
    // Write creates or replaces. Best-effort detection of pre-existence.
    try {
      operation = existsSync(filePath) ? 'edit' : 'create';
    } catch {
      operation = 'edit';
    }
    break;
  default:
    // Not a file-oriented tool we track
    process.exit(0);
}

try {
  touchSessionFile({ sessionId, path: filePath, operation });
} catch (err) {
  console.error('[posttooluse] failed:', err.message);
}

process.exit(0);
