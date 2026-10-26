#!/usr/bin/env node
/**
 * SessionEnd hook — index, enqueue for preference consolidation, bookmark.
 *
 * Node port of session-end-hook.sh (#19), and the reason #16 existed: none of these three
 * ever ran, because the event was not registered and the script was bash on a host without
 * usable bash. The preference queue looked empty because nothing had ever filled it.
 */
import { config, readStdin, runScript, recordFire } from './lib.mjs';

const cfg = config();
const agent = cfg.agent || 'default';

// Claude Code passes session metadata on stdin. Read it ONCE and fan the same copy out —
// stdin is a stream and the second reader would get nothing.
const payload = readStdin();

const results = {
  index: runScript('scripts/index-sessions.mjs', ['--dir', cfg.scanDir, '--agent', agent]).ok,
  enqueue: runScript('scripts/session-end-enqueue.mjs', ['--agent', agent], { input: payload }).ok,
  bookmark: runScript('scripts/session-end-bookmark.mjs', ['--agent', agent], { input: payload }).ok,
};

recordFire('SessionEnd', { agent, ...results });
process.exit(0);
