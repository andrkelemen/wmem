/**
 * Shared plumbing for wmem's Claude Code hooks.
 *
 * WHY THESE ARE NODE AND NOT BASH (#19). The hooks used to be `.sh` with bash-only
 * constructs — `$(cd ... && pwd)`, sourcing `$HOME/.wmemrc`, and shelling out to `python3`
 * to handle JSON. On a Windows host there is no usable bash and often no python3 on PATH,
 * so none of it ran. Node is already a hard dependency of this project, which makes it the
 * one interpreter guaranteed to be present wherever wmem works at all.
 *
 * That single packaging fault is also #16 and #20: SessionEnd was never registered, so the
 * incremental index, the preference enqueue AND the session bookmark never fired, and the
 * server's own instructions told the model to poll a queue that could not fill. The
 * features were not missing. They were unreachable.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDbPath, splitWarning } from '../../core/db-path.mjs';

export const WMEM_ROOT = process.env.WMEM_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// loadRc lives in core/db-path.mjs now, so the MCP server reads the rc file too — it was
// the one channel that could have reconciled the split store, and only the hooks used it.
export { loadRc } from '../../core/db-path.mjs';

export function config() {
  // ONE resolver, shared with core/db.mjs and the migration runner. This used to default
  // to a path under the home directory while core defaulted to a cwd-relative one, so the hooks wrote
  // every session into a store the MCP tools never opened.
  const resolution = resolveDbPath();
  const warn = splitWarning(resolution);
  if (warn) process.stderr.write(warn + '\n');
  const db = resolution.path;
  process.env.MEMORY_DB = db;                    // children inherit the same answer
  mkdirSync(dirname(db), { recursive: true });
  return {
    db,
    scanDir: process.env.WMEM_SCAN_DIR || join(homedir(), '.claude', 'projects'),
    agent: process.env.WMEM_AGENT || null,          // resolved later against the personality
    born: process.env.WMEM_BORN || null,
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  };
}

/** Read all of stdin, or '' if there is none. Never throws, never blocks forever. */
export function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

/** Run one of wmem's own node scripts. Failure is swallowed: a hook must never block. */
export function runScript(rel, args = [], { input } = {}) {
  const r = spawnSync(process.execPath, [join(WMEM_ROOT, rel), ...args], {
    cwd: WMEM_ROOT, input: input ?? undefined, encoding: 'utf8',
    env: process.env, timeout: 60_000,
  });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

/**
 * THE CANARY (#16). A hook is not verified until it has fired — producer-side checks pass
 * happily while nothing reaches the session, which is how an empty preference queue looked
 * like "nothing to consolidate" instead of "this never ran". Every fire stamps a file, and
 * `wmem doctor` reads it back, so the answer to "is SessionEnd working" becomes a date
 * instead of an inference.
 *
 * Best-effort by construction: if stamping fails the hook still does its job.
 */
export function recordFire(event, detail = {}, { throttleMs = 0 } = {}) {
  try {
    const path = join(dirname(process.env.MEMORY_DB || resolveDbPath().path), 'hook-fires.json');
    let all = {};
    try { all = JSON.parse(readFileSync(path, 'utf8')); } catch {}

    // THROTTLE, for PostToolUse. Claude Code spawns the hook once per tool call, so there is
    // no long-lived process to stamp "once per process" in — the write is inherently
    // per-call. On a working session that is thousands of read-modify-writes for a field
    // whose only consumer is `doctor --hooks` printing "last fired", where a minute of
    // resolution is ample. The read stays (it is how we know the age); the write is what
    // gets skipped.
    if (throttleMs > 0 && all[event]?.at && Date.now() - all[event].at < throttleMs) return;

    all[event] = { at: Date.now(), iso: new Date().toISOString(), ...detail };
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, path);                       // atomic: a reader never sees half a file

    // KNOWN RACE, deliberately tolerated. This is a read-modify-write on one shared file
    // with no lock. writeFileSync + renameSync makes each write atomic, so the file never
    // corrupts — but two sessions firing at once both read the old object and the second
    // rename wins, so an event can report a stale "last fired" while it is actively firing.
    // With several concurrent sessions that is the normal case, not the edge.
    //
    // Acceptable for a canary: its question is "has this EVER fired", and a stale timestamp
    // still answers that. Written down because "last fired looks stale" is exactly the
    // symptom someone will later debug as a broken hook, and this is where they will look.
  } catch {}
}

export function readFires(dbPath) {
  const path = join(dirname(dbPath || process.env.MEMORY_DB || resolveDbPath().path), 'hook-fires.json');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}
