#!/usr/bin/env node
/**
 * tests/setup-dry-run.test.mjs — `wmem init --dry-run` must not write.
 *
 * It did. On a machine with no wmem yet, the dry run left a real database behind — with
 * its WAL and SHM files — and then printed "nothing was changed". Two unguarded calls:
 * a personality lookup in step 7, and the verification block in step 10. Reading opens
 * the database, and opening it creates it, so a read is a write on a fresh machine.
 *
 * Found by installing the packed tarball against an empty HOME and listing what appeared
 * in it, which is the only way this is visible: every line of output was correct, and the
 * side effect was somewhere nobody was looking. The same failure mode as every other bug
 * in this release — a report that does not match what happened.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const check = (name, cond, got) => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; return; }
  console.log(`  ✗ ${name}\n    got: ${JSON.stringify(got)}`); failed++;
};

const home = mkdtempSync(join(tmpdir(), 'wmem-dry-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'wmem-dry-cwd-'));
const targetDb = join(home, '.wmem', 'memory.db');
try {
  let out = '';
  try {
    // --db pins the target explicitly. Without it the resolver finds the REPO's own
    // populated data/memory.db and creates nothing under the temp HOME, so the check
    // passes against the broken code — which is how the first version of this file was
    // wrong. Name the file the dry run must not create.
    out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'setup.mjs'), '--dry-run', '--db', targetDb], {
      encoding: 'utf8', cwd,
      // An empty HOME is the point: a machine that has never run wmem. CLAUDE_CONFIG_DIR
      // keeps the `claude` CLI's own files out of the directory being inspected.
      env: { ...process.env, HOME: home, USERPROFILE: home, MEMORY_DB: '', CLAUDE_CONFIG_DIR: join(cwd, 'claude-cfg') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }

  check('the dry run says it changed nothing', /dry run/i.test(out), out.slice(-200));

  const wmemDir = dirname(targetDb);
  const created = existsSync(wmemDir) ? readdirSync(wmemDir) : [];
  check('no database was created', created.length === 0, created);
  check('the target file itself is absent', !existsSync(targetDb), targetDb);
  check('no rc file was written', !existsSync(join(home, '.wmemrc')), 'wrote ~/.wmemrc');
  check('nothing was written into the working directory', !existsSync(join(cwd, 'data')), 'created data/');
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
