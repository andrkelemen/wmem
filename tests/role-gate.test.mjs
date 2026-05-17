#!/usr/bin/env node
/*
  Role gate test. Boots server.mjs on an ephemeral port + drill DB,
  asserts that POST writes are 403'd when role=mirror and 200'd when
  role=master, and verifies GET /api/wmem/role surfaces the expected
  fields.

  Spawns server as a child process. Set DEBUG=1 to keep server output.
*/

import { spawn } from 'node:child_process';
import { unlinkSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TMPDIR = mkdtempSync(join(tmpdir(), 'wmem-role-gate-'));
const DB_PATH = join(TMPDIR, 'memory.db');
const PORT = 18999;

const report = { stages: [] };
function stage(name, fn) {
  return Promise.resolve().then(async () => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      report.stages.push({ name, ok: true, ms: Date.now() - t0, detail });
      console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
    } catch (e) {
      report.stages.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
      console.error(`  ✗ ${name}: ${e.message}`);
    }
  });
}

async function bootServer(env) {
  const proc = spawn(process.execPath, [join(REPO_ROOT, 'server.mjs')], {
    env: { ...process.env, ...env, MEMORY_DB: DB_PATH, PORT: String(PORT) },
    stdio: process.env.DEBUG ? 'inherit' : 'pipe',
  });
  // wait for listen
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return proc;
    } catch {}
  }
  proc.kill();
  throw new Error('server did not come up in 6s');
}

async function killServer(proc) {
  proc.kill('SIGTERM');
  await new Promise(r => proc.once('exit', r));
}

// ── master role ──
const master = await bootServer({ WMEM_ROLE: 'master' });
await stage('master: GET /api/wmem/role returns master+writable', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/wmem/role`);
  const j = await r.json();
  assert.strictEqual(r.status, 200, `expected 200 got ${r.status}`);
  assert.strictEqual(j.role, 'master');
  assert.strictEqual(j.writable, true);
});
await stage('master: POST /api/ingest succeeds', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'test', sourceType: 'role-gate-test', content: 'master accepts' }),
  });
  const j = await r.json();
  assert.strictEqual(r.status, 200, `expected 200 got ${r.status}: ${JSON.stringify(j)}`);
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.inserted, 1);
});
await killServer(master);

// ── mirror role ── (reuse same DB; role row already exists, so flip it)
unlinkSync(DB_PATH); if (existsSync(DB_PATH + '-shm')) unlinkSync(DB_PATH + '-shm');
if (existsSync(DB_PATH + '-wal')) unlinkSync(DB_PATH + '-wal');
const mirror = await bootServer({ WMEM_ROLE: 'mirror' });
await stage('mirror: GET /api/wmem/role returns mirror+!writable', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/wmem/role`);
  const j = await r.json();
  assert.strictEqual(j.role, 'mirror');
  assert.strictEqual(j.writable, false);
});
await stage('mirror: POST /api/ingest returns 403 wmem_role_not_master', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'test', sourceType: 'role-gate-test', content: 'mirror refuses' }),
  });
  assert.strictEqual(r.status, 403, `expected 403 got ${r.status}`);
  const j = await r.json();
  assert.strictEqual(j.error, 'wmem_role_not_master');
  assert.strictEqual(j.role, 'mirror');
});
await stage('mirror: POST /api/write also 403', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'project.upsert', args: { name: 'should-refuse' } }),
  });
  assert.strictEqual(r.status, 403);
});
await stage('mirror: GET /api/search succeeds (reads NOT gated)', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/search?q=anything`);
  assert.strictEqual(r.status, 200, `reads should pass even on mirror; got ${r.status}`);
});
await killServer(mirror);

const failures = report.stages.filter(s => !s.ok);
console.log(`\nrole-gate: ${report.stages.length - failures.length}/${report.stages.length} pass`);
process.exit(failures.length === 0 ? 0 : 1);
