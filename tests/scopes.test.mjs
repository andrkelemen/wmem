#!/usr/bin/env node
/**
 * tests/scopes.test.mjs — validates project_scopes, session_files, resolver,
 * and the chunk-backfill behavior.
 */

import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';

const TEST_DB = '/tmp/wmem-scopes-test.db';
if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
process.env.MEMORY_DB = TEST_DB;

const _err = console.error;
console.error = (msg, ...rest) => {
  if (typeof msg === 'string' && (msg.startsWith('[wmem]') || msg.startsWith('[db]') || msg.startsWith('[migrate]') || msg.startsWith('[scopes]'))) return;
  _err(msg, ...rest);
};

const scopes = await import('../core/scopes.mjs');
const db = await import('../core/db.mjs');

let passed = 0;
let failed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

async function run() {
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}\n    ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1, 4).map(l => '    ' + l).join('\n'));
      failed++;
    }
  }
}

// ───────────────────────────────────────────────────────────
// PLATFORM DETECTION
// ───────────────────────────────────────────────────────────

test('detectPlatform returns a known value', () => {
  const p = scopes.detectPlatform();
  assert.ok(['windows', 'linux', 'macos', 'wsl'].includes(p), `unexpected platform: ${p}`);
});

test('_setPlatformForTesting overrides detection', () => {
  scopes._setPlatformForTesting('wsl');
  assert.equal(scopes.detectPlatform(), 'wsl');
  scopes._setPlatformForTesting('linux');
  assert.equal(scopes.detectPlatform(), 'linux');
});

// ───────────────────────────────────────────────────────────
// NORMALIZATION
// ───────────────────────────────────────────────────────────

test('normalizePath converts backslashes to forward slashes', () => {
  assert.equal(scopes.normalizePath('C:\\Projects\\app\\backend\\'), 'C:/Projects/app/backend/');
});

test('normalizePath collapses repeated slashes', () => {
  assert.equal(scopes.normalizePath('/foo//bar///baz'), '/foo/bar/baz');
});

// ───────────────────────────────────────────────────────────
// SCOPE SEED + UPSERT
// ───────────────────────────────────────────────────────────

test('fresh DB ships generic seed scopes', () => {
  const list = scopes.listScopes();
  const codes = list.map(s => s.code).sort();
  assert.deepEqual(codes, ['admin', 'backend', 'database', 'frontend']);
});

test('upsertScope creates a new scope', () => {
  const res = scopes.upsertScope({ code: 'infra', name: 'Infrastructure' });
  assert.equal(res.created, true);
  assert.ok(scopes.getScope('infra'));
});

test('upsertScope updates an existing scope', () => {
  scopes.upsertScope({ code: 'infra', name: 'Infra Renamed', description: 'updated' });
  assert.equal(scopes.getScope('infra').name, 'Infra Renamed');
});

// ───────────────────────────────────────────────────────────
// SCOPE PATHS
// ───────────────────────────────────────────────────────────

test('upsertScopePath adds a platform-specific prefix', () => {
  const res = scopes.upsertScopePath({ scope: 'backend', platform: 'linux', pathPrefix: '/home/u/app/backend' });
  assert.equal(res.created, true);
  assert.equal(res.pathPrefix, '/home/u/app/backend/'); // trailing slash auto-added
});

test('upsertScopePath normalizes windows backslashes', () => {
  const res = scopes.upsertScopePath({ scope: 'backend', platform: 'windows', pathPrefix: 'C:\\Projects\\app\\backend' });
  assert.equal(res.pathPrefix, 'C:/Projects/app/backend/');
});

test('upsertScopePath rejects prefix conflict across scopes', () => {
  scopes.upsertScope({ code: 'conflict-a', name: 'A' });
  scopes.upsertScope({ code: 'conflict-b', name: 'B' });
  scopes.upsertScopePath({ scope: 'conflict-a', platform: 'linux', pathPrefix: '/conflict/path' });
  assert.throws(
    () => scopes.upsertScopePath({ scope: 'conflict-b', platform: 'linux', pathPrefix: '/conflict/path' }),
    /already owns prefix/,
  );
});

test('upsertScopePath throws on unknown scope', () => {
  assert.throws(
    () => scopes.upsertScopePath({ scope: 'ghost', platform: 'linux', pathPrefix: '/foo' }),
    /unknown scope/,
  );
});

// ───────────────────────────────────────────────────────────
// RESOLVER
// ───────────────────────────────────────────────────────────

test('resolvePath uses current-platform prefix', () => {
  scopes._setPlatformForTesting('linux');
  assert.equal(scopes.resolvePath('backend', 'services/Api.js'), '/home/u/app/backend/services/Api.js');
  scopes._setPlatformForTesting('windows');
  assert.equal(scopes.resolvePath('backend', 'foo.cs'), 'C:/Projects/app/backend/foo.cs');
});

test('resolvePath on WSL falls back to linux', () => {
  scopes._setPlatformForTesting('wsl');
  assert.equal(scopes.resolvePath('backend', 'foo.js'), '/home/u/app/backend/foo.js');
});

test('resolvePath falls back to any registered platform with warning', () => {
  scopes._setPlatformForTesting('macos');
  // backend only has linux + windows registered; macos not registered
  const out = scopes.resolvePath('backend', 'foo.js');
  assert.match(out, /\/home\/u\/app\/backend\/foo\.js|C:\/Projects\/app\/backend\/foo\.js/);
});

test('resolvePath throws when no paths registered for scope', () => {
  scopes.upsertScope({ code: 'empty-scope', name: 'Empty' });
  scopes._setPlatformForTesting('linux');
  assert.throws(
    () => scopes.resolvePath('empty-scope', 'x'),
    /no path registered/,
  );
});

// ───────────────────────────────────────────────────────────
// SESSION_FILE_TOUCH
// ───────────────────────────────────────────────────────────

test('touchSessionFile auto-scopes via longest-prefix match', () => {
  scopes._setPlatformForTesting('linux');
  const r = scopes.touchSessionFile({
    sessionId: 's-auto', path: '/home/u/app/backend/services/Api.js', operation: 'edit',
  });
  assert.equal(r.scope, 'backend');
  assert.equal(r.path, 'services/Api.js');
});

test('touchSessionFile accepts scope-relative "scope:path" form', () => {
  const r = scopes.touchSessionFile({
    sessionId: 's-rel', path: 'backend:lib/Other.js', operation: 'edit',
  });
  assert.equal(r.scope, 'backend');
  assert.equal(r.path, 'lib/Other.js');
});

test('touchSessionFile stores absolute path with NULL scope when no prefix matches', () => {
  const r = scopes.touchSessionFile({
    sessionId: 's-nomatch', path: '/elsewhere/entirely/file.txt', operation: 'read',
  });
  assert.equal(r.scope, null);
  assert.equal(r.path, '/elsewhere/entirely/file.txt');
});

test('touchSessionFile rejects invalid operation', () => {
  assert.throws(
    () => scopes.touchSessionFile({ sessionId: 's', path: '/foo', operation: 'stare' }),
    /invalid operation/,
  );
});

test('touchSessionFile normalizes windows backslashes', () => {
  scopes._setPlatformForTesting('windows');
  const r = scopes.touchSessionFile({
    sessionId: 's-win', path: 'C:\\Projects\\app\\backend\\Api.cs', operation: 'edit',
  });
  assert.equal(r.scope, 'backend');
  assert.equal(r.path, 'Api.cs');
});

// ───────────────────────────────────────────────────────────
// LISTINGS
// ───────────────────────────────────────────────────────────

test('listSessionFiles returns file activity for a session', () => {
  const rows = scopes.listSessionFiles('s-auto');
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].session_id, 's-auto');
});

test('listFileSessions reverse-looks-up by scope + path', () => {
  const rows = scopes.listFileSessions({ scope: 'backend', path: 'services/Api.js' });
  assert.ok(rows.length >= 1);
  for (const r of rows) { assert.equal(r.scope, 'backend'); assert.equal(r.path, 'services/Api.js'); }
});

test('listFileSessions requires scope or path', () => {
  assert.throws(() => scopes.listFileSessions({}), /requires at least/);
});

test('listRecentFiles returns newest-first', () => {
  const rows = scopes.listRecentFiles({ limit: 5 });
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i-1].occurred_at >= rows[i].occurred_at);
  }
});

// ───────────────────────────────────────────────────────────
// CHUNK-ID BACKFILL ON insertChunk
// ───────────────────────────────────────────────────────────

test('insertChunk systemically backfills chunk_id on pending session_files', async () => {
  // Create unlinked session_files for a fresh session, then insert a chunk.
  // The chunk insert should link them.
  scopes._setPlatformForTesting('linux');
  scopes.touchSessionFile({ sessionId: 's-link', path: '/home/u/app/backend/foo.js', operation: 'edit' });
  scopes.touchSessionFile({ sessionId: 's-link', path: '/home/u/app/backend/bar.js', operation: 'read' });

  const d = db.getDb();
  const before = d.prepare('SELECT COUNT(*) c FROM session_files WHERE session_id = ? AND chunk_id IS NULL').get('s-link').c;
  assert.equal(before, 2);

  const res = db.insertChunk({
    agent: 'test', sourceType: 'conversation', sourceId: 's-link-0',
    sessionId: 's-link', content: 'some turn', timestamp: Date.now(),
  });

  const after = d.prepare('SELECT COUNT(*) c FROM session_files WHERE session_id = ? AND chunk_id = ?').get('s-link', res.id).c;
  assert.equal(after, 2);
  const stillUnlinked = d.prepare('SELECT COUNT(*) c FROM session_files WHERE session_id = ? AND chunk_id IS NULL').get('s-link').c;
  assert.equal(stillUnlinked, 0);
});

test('insertChunk leaves other sessions\' pending rows alone', async () => {
  scopes.touchSessionFile({ sessionId: 's-other', path: '/home/u/app/backend/x.js', operation: 'edit' });
  const d = db.getDb();

  db.insertChunk({
    agent: 'test', sourceType: 'conversation', sourceId: 's-link-1',
    sessionId: 's-link', content: 'different session', timestamp: Date.now(),
  });

  const otherUnlinked = d.prepare('SELECT COUNT(*) c FROM session_files WHERE session_id = ? AND chunk_id IS NULL').get('s-other').c;
  assert.equal(otherUnlinked, 1);
});

await run();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
