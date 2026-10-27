#!/usr/bin/env node
/**
 * SessionEnd hook — index, enqueue for preference consolidation, bookmark.
 *
 * Node port of session-end-hook.sh (#19), and the reason #16 existed: none of these three
 * ever ran, because the event was not registered and the script was bash on a host without
 * usable bash. The preference queue looked empty because nothing had ever filled it.
 */
import { config, readStdin, runScript, recordFire, resolveAgent } from './lib.mjs';

const cfg = config();
// Same resolution as SessionStart, from the same function. This line used to read
// its own fallback literal instead, which filed every session end under the default
// agent even when a real personality was active.
const agent = await resolveAgent(cfg);

// Claude Code passes session metadata on stdin. Read it ONCE and fan the same copy out —
// stdin is a stream and the second reader would get nothing.
const payload = readStdin();

// STAMP AS WE GO, NOT AT THE END.
//
// The stamp used to be a single write after all three steps. Claude Code gives an exit
// hook a short window, and the bookmark step could overrun it — so the process was killed,
// `recordFire` never ran, and `doctor --hooks` reported a stale "last fired" while the
// index, the enqueue and the bookmark had all actually succeeded. The canary said nothing
// had happened because the canary was the last thing in the queue.
//
// A record written only on success cannot describe a failure, and a hook that may be
// killed is a hook whose progress has to be durable at each step. Three writes per session
// end is nothing; this is not the per-tool-call path.
const results = { agent };
const step = (name, run) => {
  results[name] = run().ok;
  recordFire('SessionEnd', { ...results, complete: false });
  return results[name];
};

step('index', () => runScript('scripts/index-sessions.mjs', ['--dir', cfg.scanDir, '--agent', agent]));
step('enqueue', () => runScript('scripts/session-end-enqueue.mjs', ['--agent', agent], { input: payload }));
step('bookmark', () => runScript('scripts/session-end-bookmark.mjs', ['--agent', agent], { input: payload }));

recordFire('SessionEnd', { ...results, complete: true });
process.exit(0);
