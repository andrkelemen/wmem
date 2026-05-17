#!/usr/bin/env node
/*
  /api/write dispatcher test. Boots server.mjs as master on an ephemeral
  port + drill DB, exercises a known op (project.upsert), an unknown op
  (expects 404 with known_ops list), and a malformed body (expects 400).
*/

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TMPDIR = mkdtempSync(join(tmpdir(), 'wmem-dispatcher-'));
const DB_PATH = join(TMPDIR, 'memory.db');
const PORT = 18998;

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

const server = spawn(process.execPath, [join(REPO_ROOT, 'server.mjs')], {
  env: { ...process.env, WMEM_ROLE: 'master', MEMORY_DB: DB_PATH, PORT: String(PORT) },
  stdio: process.env.DEBUG ? 'inherit' : 'pipe',
});
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 200));
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
}

await stage('known op project.upsert returns 200 + result.created', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'project.upsert', args: { name: 'disp-smoke', status: 'active' } }),
  });
  const j = await r.json();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.op, 'project.upsert');
  assert.strictEqual(j.result.created, true);
});

await stage('unknown op returns 404 with known_ops list', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'totally.fake.op', args: {} }),
  });
  const j = await r.json();
  assert.strictEqual(r.status, 404);
  assert.strictEqual(j.error, 'unknown_op');
  assert.strictEqual(j.op, 'totally.fake.op');
  assert.ok(Array.isArray(j.known_ops) && j.known_ops.length > 10, 'known_ops should list registered ops');
  assert.ok(j.known_ops.includes('project.upsert'), 'known_ops should include project.upsert');
});

await stage('missing op returns 400 missing_op', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: {} }),
  });
  const j = await r.json();
  assert.strictEqual(r.status, 400);
  assert.strictEqual(j.error, 'missing_op');
});

await stage('project.ship updates the row created by upsert', async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'project.ship', args: { name: 'disp-smoke', note: 'shipped via dispatcher' } }),
  });
  const j = await r.json();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(j.result.shipped, true);
});

server.kill('SIGTERM');
await new Promise(r => server.once('exit', r));

const failures = report.stages.filter(s => !s.ok);
console.log(`\ndispatcher: ${report.stages.length - failures.length}/${report.stages.length} pass`);
process.exit(failures.length === 0 ? 0 : 1);
