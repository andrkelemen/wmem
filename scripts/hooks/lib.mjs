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

export const WMEM_ROOT = process.env.WMEM_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Read ~/.wmemrc. It is a shell file by history, so parse the subset that is actually
 * used — KEY=VALUE, optional `export`, optional quotes, # comments — and ignore anything
 * else rather than pretending to be a shell. Values already in the environment win,
 * matching the old `[ -f ] && . file` ordering where env overrides came after.
 */
export function loadRc(env = process.env) {
  const rc = join(homedir(), '.wmemrc');
  if (!existsSync(rc)) return env;
  for (const raw of readFileSync(rc, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim().replace(/\s+#.*$/, '');
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[m[1]] === undefined) env[m[1]] = v;
  }
  return env;
}

export function config() {
  loadRc();
  const db = process.env.MEMORY_DB || join(homedir(), '.wmem', 'memory.db');
  process.env.MEMORY_DB = db;
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
export function recordFire(event, detail = {}) {
  try {
    const path = join(dirname(process.env.MEMORY_DB || join(homedir(), '.wmem', 'memory.db')), 'hook-fires.json');
    let all = {};
    try { all = JSON.parse(readFileSync(path, 'utf8')); } catch {}
    all[event] = { at: Date.now(), iso: new Date().toISOString(), ...detail };
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, path);                       // atomic: a reader never sees half a file
  } catch {}
}

export function readFires(dbPath) {
  const path = join(dirname(dbPath || process.env.MEMORY_DB || join(homedir(), '.wmem', 'memory.db')), 'hook-fires.json');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}
