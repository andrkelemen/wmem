/**
 * ONE resolver for the database path. Imported by core/db.mjs, the migration runner and
 * the hooks, so that all three can never disagree again.
 *
 * THE BUG THIS EXISTS TO END (reported by a user, 2026-10-27). wmem had three different
 * defaults for an unset MEMORY_DB:
 *
 *   core/db.mjs          './data/memory.db'          relative to the process cwd
 *   migrations/_runner   'data/memory.db'            relative to the process cwd
 *   scripts/hooks/lib    ~/.wmem/memory.db           absolute
 *
 * and `scripts/setup.mjs` registered the MCP server with MEMORY_DB=<install>/data/memory.db
 * baked into the command while registering the hooks with no environment at all. So on a
 * default `npx wmem init` the hooks wrote every session into ~/.wmem/memory.db and every
 * MCP tool read <install>/data/memory.db. Two live stores, both reporting success, and a
 * memory_search that could never find what the hooks had just saved.
 *
 * Nothing errored, which is what made it survive a release. A split store is not a crash;
 * it is a silence.
 *
 * `loadRc()` already read ~/.wmemrc and would have reconciled all of it — but setup never
 * wrote that file. The read side shipped and the write side did not, which is the same
 * shape as #17. Both halves are fixed together or neither is.
 *
 * THE RULES HERE
 *
 * 1. An explicit MEMORY_DB always wins, and is made absolute. A relative default is how
 *    you get a fresh empty database every time you cd.
 * 2. With nothing explicit, prefer a store that ALREADY HAS DATA over creating a new one.
 *    Silently opening an empty database next to a full one is the failure above, repeated.
 * 3. If more than one candidate holds data, do not choose. Say all of them, loudly, and
 *    let a person decide — an automatic merge of two divergent stores is unrecoverable,
 *    and this is exactly the population that has already lost sessions to the split.
 */
import { existsSync, statSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The one place a fresh install puts its database. Absolute, cwd-independent. */
export const canonicalDb = (home = homedir()) => join(home, '.wmem', 'memory.db');
export const CANONICAL_DB = canonicalDb();

/**
 * Read ~/.wmemrc. It is a shell file by history, so parse the subset that is actually
 * used — KEY=VALUE, optional `export`, optional quotes, # comments — and ignore anything
 * else rather than pretending to be a shell. Values already in the environment win,
 * matching the old `[ -f ] && . file` ordering where env overrides came after.
 *
 * Lives here rather than in the hooks because the MCP server needs it too: the rc file is
 * the only channel that reaches a process nobody passed an environment to.
 */
export function loadRc(env = process.env, rcPath = join(homedir(), '.wmemrc')) {
  if (!existsSync(rcPath)) return env;
  for (const raw of readFileSync(rcPath, 'utf8').split('\n')) {
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

/**
 * Every location wmem has ever defaulted to, so an existing store is found, not orphaned.
 *
 * `home` and `pkgRoot` are injectable because otherwise the one case that matters most —
 * a FRESH install, where none of these exist — is untestable from inside a populated
 * checkout, and an untestable case is how this bug reached a release.
 */
export function candidateDbPaths({ cwd = process.cwd(), home = homedir(), pkgRoot = PKG_ROOT } = {}) {
  return [...new Set([
    canonicalDb(home),
    resolve(pkgRoot, 'data', 'memory.db'),
    resolve(cwd, 'data', 'memory.db'),
  ])];
}

const hasData = (p) => {
  try { return existsSync(p) && statSync(p).size > 0; } catch { return false; }
};

/**
 * Resolve the database path.
 *
 * Returns { path, source, rejected } — `source` is how it was decided, and `rejected`
 * names other stores that hold data, so a caller can tell the user instead of guessing.
 * Nothing here creates the file; only `ensureDbDir` touches the disk.
 */
export function resolveDbPath({ env = process.env, cwd = process.cwd(), rc = true, home = homedir(), pkgRoot = PKG_ROOT } = {}) {
  if (rc) loadRc(env, join(home, '.wmemrc'));

  if (env.MEMORY_DB) {
    const p = isAbsolute(env.MEMORY_DB) ? env.MEMORY_DB : resolve(cwd, env.MEMORY_DB);
    return { path: p, source: 'MEMORY_DB', rejected: [] };
  }

  const populated = candidateDbPaths({ cwd, home, pkgRoot }).filter(hasData);

  if (populated.length === 1) {
    return { path: populated[0], source: 'found', rejected: [] };
  }

  if (populated.length > 1) {
    // Prefer the canonical one so behaviour is at least deterministic, but hand back the
    // others so the caller can shout. Choosing quietly here is the original bug.
    const canonical = canonicalDb(home);
    const chosen = populated.includes(canonical) ? canonical : populated[0];
    return { path: chosen, source: 'split', rejected: populated.filter(p => p !== chosen) };
  }

  return { path: canonicalDb(home), source: 'fresh', rejected: [] };
}

/** The common case: just the path, with its directory created. */
export function dbPath(opts = {}) {
  const r = resolveDbPath(opts);
  mkdirSync(dirname(r.path), { recursive: true });
  return r.path;
}

/**
 * Every candidate location with what is actually in it, for `wmem doctor`.
 *
 * The acceptance condition on the report was that the doctor FLAGS a divergence rather
 * than merely resolving one. Both halves share a resolver now, so they can only diverge
 * through an explicit MEMORY_DB given to one process and not the other — which is
 * invisible from inside either. So show the whole picture: every place a wmem database
 * has ever been put, which one is open, and what the rc file says, in one view.
 */
export function describeDbCandidates({ cwd = process.cwd(), home = homedir(), pkgRoot = PKG_ROOT, env = process.env } = {}) {
  const active = resolveDbPath({ env: { ...env }, cwd, home, pkgRoot, rc: true });
  const rcEnv = loadRc({}, join(home, '.wmemrc'));
  const rows = candidateDbPaths({ cwd, home, pkgRoot }).map((path) => {
    let bytes = null;
    try { bytes = existsSync(path) ? statSync(path).size : null; } catch {}
    return { path, exists: bytes !== null, bytes, active: path === active.path };
  });
  // An explicit MEMORY_DB can point somewhere not on the candidate list at all.
  if (!rows.some(r => r.active)) {
    let bytes = null;
    try { bytes = existsSync(active.path) ? statSync(active.path).size : null; } catch {}
    rows.unshift({ path: active.path, exists: bytes !== null, bytes, active: true });
  }
  return {
    active: active.path,
    source: active.source,
    envMemoryDb: env.MEMORY_DB || null,
    rcMemoryDb: rcEnv.MEMORY_DB || null,
    candidates: rows,
    populated: rows.filter(r => r.bytes > 0).length,
  };
}

/**
 * One line of warning, or null. Written once here so the server, the hooks and the doctor
 * all say the same sentence — a split that is described differently in three places reads
 * as three unrelated oddities.
 */
export function splitWarning(r) {
  if (r.source !== 'split') return null;
  return `wmem: more than one database holds data.\n`
    + `  using:   ${r.path}\n`
    + r.rejected.map(p => `  ignored: ${p}\n`).join('')
    + `  Set MEMORY_DB (or MEMORY_DB=... in ~/.wmemrc) to choose deliberately.\n`
    + `  They are NOT merged automatically — sessions written to the ignored store are not lost, but are not visible here.`;
}
