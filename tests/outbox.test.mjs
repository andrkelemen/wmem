#!/usr/bin/env node
/*
  Outbox daemon test. Boots an upstream server.mjs (master) and a
  wmem-outbox daemon pointed at it. Exercises:
    - passthrough: POST through outbox lands on upstream
    - buffer-on-unreachable: kill upstream → POST returns 202 buffered
    - drain-on-restore: restart upstream → daemon drains pending writes

  Drains rely on the daemon's auto-tick + exponential backoff. The first
  drain attempt happens within tickIntervalMs (5s default); failed rows
  retry after baseBackoffS (30s default). For test speed we shorten both
  via env overrides.
*/

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TMPDIR = mkdtempSync(join(tmpdir(), 'wmem-outbox-test-'));
const DB_PATH = join(TMPDIR, 'memory.db');
const OUTBOX_DB = join(TMPDIR, 'outbox.db');
const UPSTREAM_PORT = 18996;
const OUTBOX_PORT = 18997;

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

async function waitForUp(url, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, 200));
    try { if ((await fetch(url)).ok) return; } catch {}
  }
  throw new Error(`${url} did not come up`);
}

function bootUpstream() {
  return spawn(process.execPath, [join(REPO_ROOT, 'server.mjs')], {
    env: { ...process.env, WMEM_ROLE: 'master', MEMORY_DB: DB_PATH, PORT: String(UPSTREAM_PORT) },
    stdio: process.env.DEBUG ? 'inherit' : 'pipe',
  });
}
function bootOutbox() {
  return spawn(process.execPath, [join(REPO_ROOT, 'modules/wmem-outbox/src/server.mjs')], {
    env: {
      ...process.env,
      WMEM_OUTBOX_DB: OUTBOX_DB,
      WMEM_UPSTREAM_HOST: '127.0.0.1',
      WMEM_UPSTREAM_PORT: String(UPSTREAM_PORT),
      WMEM_OUTBOX_PORT: String(OUTBOX_PORT),
      WMEM_OUTBOX_TICK_S: '1',
      WMEM_OUTBOX_BACKOFF_BASE_S: '1',
      WMEM_OUTBOX_PROBE_S: '1',
      WMEM_OUTBOX_TIMEOUT_MS: '1000',
      LOG_LEVEL: process.env.DEBUG ? 'info' : 'warn',
    },
    stdio: process.env.DEBUG ? 'inherit' : 'pipe',
  });
}

let upstream = bootUpstream();
await waitForUp(`http://127.0.0.1:${UPSTREAM_PORT}/health`);
const outbox = bootOutbox();
await waitForUp(`http://127.0.0.1:${OUTBOX_PORT}/health`);
// give probe one tick to discover upstream
await new Promise(r => setTimeout(r, 1500));

await stage('passthrough: POST to outbox lands on upstream as 200', async () => {
  const r = await fetch(`http://127.0.0.1:${OUTBOX_PORT}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'test', sourceType: 'outbox-smoke', sourceId: 'pass-1', content: 'passthrough' }),
  });
  const j = await r.json();
  assert.strictEqual(r.status, 200, `expected 200 got ${r.status}: ${JSON.stringify(j)}`);
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.inserted, 1);
});

// Kill upstream → outbox sees unreachable on next probe
upstream.kill('SIGTERM');
await new Promise(r => upstream.once('exit', r));
await new Promise(r => setTimeout(r, 1500));

await stage('buffer: POST while upstream down returns 202 buffered', async () => {
  const r = await fetch(`http://127.0.0.1:${OUTBOX_PORT}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'test', sourceType: 'outbox-smoke', sourceId: 'buf-1', content: 'should buffer' }),
  });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.headers.get('x-wmem-outbox'), 'buffered');
  const j = await r.json();
  assert.strictEqual(j.buffered, true);
  assert.ok(j.outbox_id, 'should return outbox_id');
});

await stage('health reflects outbox_pending>=1 while upstream down', async () => {
  const r = await fetch(`http://127.0.0.1:${OUTBOX_PORT}/health`);
  const j = await r.json();
  assert.strictEqual(j.upstream_reachable, false);
  assert.ok(j.outbox_pending >= 1, `expected pending >= 1, got ${j.outbox_pending}`);
});

// Restart upstream → daemon should drain on next tick
upstream = bootUpstream();
await waitForUp(`http://127.0.0.1:${UPSTREAM_PORT}/health`);

await stage('drain: pending count goes to 0 after upstream comes back', async () => {
  // Poll up to 15s. Probe re-discovers upstream (1s tick), then drain runs
  // after backoff (1s * 2^retry_count). Force drain each iteration to
  // bypass tick delay.
  let last;
  for (let i = 0; i < 75; i++) {
    await new Promise(r => setTimeout(r, 200));
    await fetch(`http://127.0.0.1:${OUTBOX_PORT}/admin/drain`, { method: 'POST' }).catch(() => {});
    last = await (await fetch(`http://127.0.0.1:${OUTBOX_PORT}/health`)).json();
    if (last.upstream_reachable && last.outbox_pending === 0) return;
  }
  throw new Error(`did not drain in 15s: ${JSON.stringify(last)}`);
});

await stage('drained row landed on upstream as a real chunk', async () => {
  const r = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/search?q=buffer&agent=test`);
  const j = await r.json();
  assert.ok(Array.isArray(j.results), 'search should return results array');
  const found = j.results.find(c => c.sourceId === 'buf-1' || (c.content || '').includes('should buffer'));
  assert.ok(found, 'expected the buffered row to be searchable on upstream after drain');
});

outbox.kill('SIGTERM');
await new Promise(r => outbox.once('exit', r));
upstream.kill('SIGTERM');
await new Promise(r => upstream.once('exit', r));

const failures = report.stages.filter(s => !s.ok);
console.log(`\noutbox: ${report.stages.length - failures.length}/${report.stages.length} pass`);
process.exit(failures.length === 0 ? 0 : 1);
