#!/usr/bin/env node
// smoke.mjs — end-to-end test harness for wmem-outbox.
//
// Requires: upstream wmem at WMEM_UPSTREAM_HOST:18420, daemon running locally.
// Tests:
//   1. health endpoint OK + upstream_reachable=true
//   2. passthrough: mail send via :18421 lands on upstream
//   3. buffer: stop upstream → send → assert 202+buffered
//   4. drain: start upstream → wait → assert outbox empties
//
// CAUTION: step 3-4 stop+start a real upstream service. Only run on a box where
// you can sudo systemctl wmem.service.

const DAEMON = process.env.WMEM_OUTBOX_URL ?? 'http://127.0.0.1:18421';
const UPSTREAM_URL = process.env.WMEM_UPSTREAM_URL    ?? 'http://127.0.0.1:18420';
const SSH_UPSTREAM = process.env.SSH_UPSTREAM         ?? null; // 'user@upstream' if remote
const SKIP_DESTRUCTIVE = process.env.SMOKE_SKIP_DESTRUCTIVE === '1';

const log = (...a) => console.error('  ·', ...a);
const pass = (msg) => console.log(`\x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`\x1b[31m✗\x1b[0m ${msg}`); process.exit(1); };

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Caller': 'smoke-agent' },
    body: JSON.stringify(body),
  });
  return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function step1_health() {
  console.log('\n[1] daemon /health + upstream_reachable');
  const h = await getJSON(`${DAEMON}/health`);
  log(`upstream_reachable=${h.upstream_reachable} role=${h.upstream_role} pending=${h.outbox_pending}`);
  if (!h.ok) fail('health.ok != true');
  if (!h.upstream_reachable) fail('upstream not reachable at smoke start — fix before smoking');
  pass('health endpoint OK');
}

async function step2_passthrough() {
  console.log('\n[2] passthrough: send mail via :18421');
  const ts = Date.now();
  const subject = `outbox-smoke-passthrough-${ts}`;
  const r = await postJSON(`${DAEMON}/api/mail/send`, {
    to: 'smoke-agent', body: 'passthrough smoke', subject,
  });
  log(`status=${r.status} body=${r.body.slice(0, 100)}`);
  if (r.headers['x-wmem-outbox'] === 'buffered') fail('expected passthrough, got buffered');
  if (r.status < 200 || r.status >= 300) fail(`expected 2xx, got ${r.status}`);
  pass('passthrough delivered');
}

async function step3_buffer() {
  if (SKIP_DESTRUCTIVE) { console.log('\n[3] SKIPPED (destructive)'); return null; }
  console.log('\n[3] buffer: stop upstream wmem → send → expect 202+buffered');
  const stopCmd = SSH_UPSTREAM
    ? `ssh ${SSH_UPSTREAM} "XDG_RUNTIME_DIR=/run/user/$(ssh ${SSH_UPSTREAM} id -u) systemctl --user stop wmem"`
    : `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user stop wmem`;
  log(`run: ${stopCmd}`);
  const { execSync } = await import('node:child_process');
  execSync(stopCmd);
  log('upstream wmem stopped, waiting 12s for probe to notice...');
  await sleep(12000);
  const h = await getJSON(`${DAEMON}/health`);
  if (h.upstream_reachable) fail('probe still thinks upstream reachable after 12s');
  log(`upstream_reachable now ${h.upstream_reachable}`);

  const ts = Date.now();
  const r = await postJSON(`${DAEMON}/api/mail/send`, {
    to: 'smoke-agent', body: 'buffered smoke', subject: `outbox-smoke-buffered-${ts}`,
  });
  log(`status=${r.status} x-wmem-outbox=${r.headers['x-wmem-outbox']}`);
  if (r.status !== 202) fail(`expected 202, got ${r.status}`);
  if (r.headers['x-wmem-outbox'] !== 'buffered') fail('missing X-Wmem-Outbox header');
  pass('write buffered to outbox');
  const body = JSON.parse(r.body);
  return body.outbox_id;
}

async function step4_drain(bufferedId) {
  if (SKIP_DESTRUCTIVE) { console.log('\n[4] SKIPPED (destructive)'); return; }
  console.log('\n[4] drain: start upstream → wait for reconnect → trigger drain → expect empty');
  const startCmd = SSH_UPSTREAM
    ? `ssh ${SSH_UPSTREAM} "XDG_RUNTIME_DIR=/run/user/$(ssh ${SSH_UPSTREAM} id -u) systemctl --user start wmem"`
    : `XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user start wmem`;
  log(`run: ${startCmd}`);
  const { execSync } = await import('node:child_process');
  execSync(startCmd);
  log('upstream wmem started, waiting 15s for probe to reconnect...');
  await sleep(15000);
  const h1 = await getJSON(`${DAEMON}/health`);
  log(`upstream_reachable now ${h1.upstream_reachable}`);
  if (!h1.upstream_reachable) fail('probe still thinks upstream unreachable after 15s');

  log('triggering drain...');
  await postJSON(`${DAEMON}/admin/drain`, {});
  await sleep(2000);
  const h2 = await getJSON(`${DAEMON}/health`);
  log(`outbox_pending=${h2.outbox_pending} last_drain=${h2.last_drain_result}`);
  if (h2.outbox_pending !== 0) fail(`expected 0 pending, got ${h2.outbox_pending}`);
  pass('outbox drained to upstream');
}

(async () => {
  console.log(`\nwmem-outbox smoke harness`);
  console.log(`daemon: ${DAEMON}`);
  console.log(`upstream:    ${UPSTREAM_URL}`);
  console.log(`destructive steps: ${SKIP_DESTRUCTIVE ? 'SKIPPED' : 'ENABLED'}`);

  try {
    await step1_health();
    await step2_passthrough();
    const id = await step3_buffer();
    await step4_drain(id);
    console.log('\n\x1b[32mAll smoke tests passed.\x1b[0m\n');
  } catch (err) {
    fail(`exception: ${err.message}`);
  }
})();
