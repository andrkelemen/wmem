#!/usr/bin/env node
/*
  The split-database bug, reported 2026-10-27 — and the shape of it is why this file exists.

  wmem had three defaults for an unset MEMORY_DB: './data/memory.db' in core, the same
  relative path in the migration runner, and ~/.wmem/memory.db in the hooks. `setup.mjs`
  registered the MCP server with MEMORY_DB=<install>/data/memory.db baked into the command
  and registered the hooks with no environment at all. So on a default install the hooks
  wrote every session into one database and every MCP tool read another.

  NOTHING ERRORED. That is the whole difficulty: a split store does not crash, it goes
  quiet, and a release went out with it. There was no test asserting that two components
  agree about where the data lives, because agreeing felt too obvious to assert.

  Every case below has been checked red against the pre-fix defaults.
*/
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const { resolveDbPath, loadRc, CANONICAL_DB } = await import(join(ROOT, 'core', 'db-path.mjs'));

let failed = 0;
const check = (name, cond, got) => {
  if (cond) { console.log(`  ok    ${name}`); return; }
  failed++;
  console.log(`  FAIL  ${name}\n        got: ${JSON.stringify(got)}`);
};

const tmp = mkdtempSync(join(tmpdir(), 'wmem-dbpath-'));
const home = join(tmp, 'home');
const elsewhere = join(tmp, 'elsewhere');
mkdirSync(home, { recursive: true });
mkdirSync(elsewhere, { recursive: true });

const populate = (p) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, 'x'.repeat(64)); };

try {
  // 1. An explicit MEMORY_DB always wins, and a relative one is made absolute — a
  //    cwd-relative path is how you silently get a new empty database per directory.
  let r = resolveDbPath({ env: { MEMORY_DB: 'data/memory.db' }, cwd: elsewhere, rc: false });
  check('explicit MEMORY_DB wins', r.source === 'MEMORY_DB', r);
  check('relative MEMORY_DB is absolutised', r.path === join(elsewhere, 'data', 'memory.db'), r.path);

  // 2. With nothing to go on and nothing on disk, every caller lands on the same absolute
  //    path. This is the assertion whose absence allowed the split.
  const freshHome = join(tmp, 'fresh-home');
  const freshPkg = join(tmp, 'fresh-pkg');
  mkdirSync(freshHome, { recursive: true });
  mkdirSync(freshPkg, { recursive: true });
  r = resolveDbPath({ env: {}, cwd: freshPkg, rc: false, home: freshHome, pkgRoot: freshPkg });
  check('fresh install uses the canonical path',
    r.path === join(freshHome, '.wmem', 'memory.db') && r.source === 'fresh', r);

  // 3. An existing store with data is preferred over creating an empty one beside it.
  //    Without this, fixing the default would have pointed every upgrading user at a
  //    blank database and called it a successful install.
  const existing = join(ROOT, 'data', 'memory.db');
  r = resolveDbPath({ env: {}, cwd: ROOT, rc: false });
  check('an existing populated store is found, not orphaned', r.path === existing && r.source === 'found', r);

  // 4. Two populated stores must NOT be chosen between quietly. This is the state every
  //    already-affected user is in, and an automatic pick hides half their sessions.
  const other = join(elsewhere, 'data', 'memory.db');
  populate(other);
  r = resolveDbPath({ env: {}, cwd: elsewhere, rc: false });
  check('a split is reported as a split', r.source === 'split', r);
  check('the ignored store is named', r.rejected.includes(other) || r.rejected.includes(existing), r.rejected);

  // 5. ~/.wmemrc supplies MEMORY_DB to a process nobody passed an environment to — the
  //    only channel that reaches a hook. Reading it was never the problem; see setup.
  const rcPath = join(home, '.wmemrc');
  writeFileSync(rcPath, '# comment\nexport MEMORY_DB="/tmp/from-rc.db"\nWMEM_AGENT=someone\n');
  const env = {};
  loadRc(env, rcPath);
  check('rc supplies MEMORY_DB', env.MEMORY_DB === '/tmp/from-rc.db', env);
  check('rc does not clobber a real environment', loadRc({ MEMORY_DB: '/keep.db' }, rcPath).MEMORY_DB === '/keep.db', 'clobbered');

  // 5b. The doctor's view must include an explicit MEMORY_DB even when it is nowhere near
  //     a default location — otherwise the one report a person reads after losing sessions
  //     omits the very file they are reading from.
  const { describeDbCandidates } = await import(join(ROOT, 'core', 'db-path.mjs'));
  const off = join(elsewhere, 'somewhere-else.db');
  populate(off);
  const d = describeDbCandidates({ env: { MEMORY_DB: off }, cwd: elsewhere, home });
  check('the report marks exactly one active database',
    d.candidates.filter(c => c.active).length === 1, d.candidates);
  check('an off-list MEMORY_DB still appears in the report',
    d.active === off && d.candidates.some(c => c.path === off), d);

  // 5c. NO SOURCE FILE MAY CARRY ITS OWN `data/memory.db`, in code OR in a usage example.
  //     The bug came back twice after the resolver landed — once as a live fallback in
  //     core/doctor.mjs, once as four copy-paste lines in scripts/reimport.mjs that told
  //     the reader to recreate the split by hand. Documentation that hands out a
  //     cwd-relative path is the same defect as code that defaults to one, and a reviewer
  //     reading a diff will not catch either. So the repo checks itself.
  const skip = new Set(['node_modules', '.git', 'data', 'tests']);
  const allowed = (f) => f.endsWith('core/db-path.mjs') || f.endsWith('CHANGELOG.md');
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(mjs|js|md|sh)$/.test(e.name)) continue;
      if (allowed(full)) continue;
      const text = readFileSync(full, 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        // A relative path ending in memory.db. An absolute one is a deliberate choice.
        if (/(^|[^/\w])\.?\.?\/?data\/memory\.db/.test(line) && !/\$\{|<install>/.test(line)) {
          offenders.push(`${relative(ROOT, full)}:${i + 1}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
  };
  walk(ROOT);
  check('no file carries its own relative data/memory.db', offenders.length === 0, offenders);

  // 6. THE REGRESSION ITSELF: the hooks and the server must resolve to the same file.
  //    Run in a child so the hook module's import-time work is real, not mocked.
  const probe = `
    const core = (await import(${JSON.stringify(join(ROOT, 'core', 'db-path.mjs'))})).resolveDbPath();
    const lib  = await import(${JSON.stringify(join(ROOT, 'scripts', 'hooks', 'lib.mjs'))});
    console.log(JSON.stringify({ core: core.path, hook: lib.config().db }));
  `;
  const envNoDb = { ...process.env };
  delete envNoDb.MEMORY_DB;
  const outLine = execFileSync(process.execPath, ['--input-type=module', '-e', probe],
    { encoding: 'utf8', env: envNoDb, cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop();
  const both = JSON.parse(outLine);
  check('hooks and core agree on the database', both.core === both.hook, both);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  try { rmSync(join(tmpdir(), 'nothing'), { force: true }); } catch {}
}

console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
