#!/usr/bin/env node
/*
  The caller layer — every invocation of the binary must EXIT.

  Both bugs in this cycle lived here, where a handler meets its caller, and this layer had
  no tests:

    * handleWmemDedup referenced an `args` binding it never took, so every call over MCP
      threw ReferenceError. `node --check` passes that happily: the syntax was never wrong.
    * `--help` and `-h` were excluded by the very guard that preceded the block handling
      them, so they started an MCP server on stdio — no output, no error, no exit, a
      terminal waiting for JSON-RPC frames.

  Neither is findable by reading, and neither is findable by unit-testing the function.
  They are findable by running the thing. So this runs the thing.

  TWO FLAWS IN THE FIRST VERSION OF THIS FILE, both of which made it pass against the broken
  code — a test that cannot go red proves nothing:

    * `input: ''` closes stdin immediately, so the MCP server reads EOF and exits 0. The
      hang only happens against a terminal that stays open, which no test should wait for.
      So the assertion cannot be "did it exit" at all.
    * the needle was the word "wmem", which the server's own startup banner contains. It
      matched the failure it was meant to catch.

  So the real assertion is about WHICH PROGRAM RAN: help must print the help text and must
  NOT print the server's banner. That distinguishes the two outcomes without depending on
  stdin behaviour, and it fails against the pre-fix guard.
*/

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TMPDIR = mkdtempSync(join(tmpdir(), 'wmem-cli-'));

function run(args, timeout = 90_000) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'mcp-server.mjs'), ...args], {
    input: '', encoding: 'utf8', timeout, cwd: REPO_ROOT,
    env: { ...process.env, HOME: TMPDIR, MEMORY_DB: join(TMPDIR, 'memory.db') },
  });
}

// Anything only the SERVER prints. If this appears, the dispatcher fell through and the
// binary became an MCP server when it was asked a question.
const SERVER_BANNER = 'mcp server connected';

const CASES = [
  { args: ['help'],   status: 0, mentions: 'run as an MCP server over stdio', notServer: true },
  { args: ['--help'], status: 0, mentions: 'run as an MCP server over stdio', notServer: true },
  { args: ['-h'],     status: 0, mentions: 'run as an MCP server over stdio', notServer: true },
  { args: ['doctor', 'status'], status: 0, mentions: 'chunks', notServer: true },
  { args: ['hooks', '--print-only', '--settings', join(TMPDIR, 'settings.json')], status: 0, mentions: 'hooks', notServer: true },
  { args: ['definitely-not-a-subcommand'], status: 2, mentions: 'unknown subcommand', notServer: true },
];

let failed = 0;
for (const c of CASES) {
  const label = `wmem ${c.args[0]}`;
  try {
    const r = run(c.args);
    assert.strictEqual(r.signal, null, `${label} never exited — killed with ${r.signal}`);
    assert.strictEqual(r.status, c.status, `${label} exited ${r.status}, expected ${c.status}`);
    const out = `${r.stdout || ''}${r.stderr || ''}`.toLowerCase();
    assert.ok(out.includes(c.mentions.toLowerCase()), `${label} output never mentioned "${c.mentions}"`);
    if (c.notServer) {
      assert.ok(!out.includes(SERVER_BANNER),
        `${label} started the MCP SERVER instead of answering — the dispatcher guard let it fall through`);
    }
    console.log(`  ✓ ${label} exits ${c.status}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${label}\n    ${err.message}`);
  }
}

console.log(failed === 0 ? '\ncli: all invocations exit' : `\ncli: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
