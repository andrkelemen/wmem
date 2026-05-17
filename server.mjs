/**
 * server.mjs — wmem HTTP service
 * Express on port 18420 by default (override via PORT env or wmem.config.json).
 * SQLite + FTS5. Shared index, per-agent partitions.
 *
 * Day 1 endpoints:
 *   POST /api/ingest — store chunks (messages, memory files, identity files)
 *   GET  /api/search — FTS5 keyword search with optional agent/type filters
 *   GET  /api/stats  — index stats for monitoring
 *
 * 
 */

import express from 'express';
import { readFileSync } from 'fs';
import { timingSafeEqual } from 'crypto';
import { insertChunk, search, getRecent, getStats, getDb, amendChunk, shareChunk, markPersonal, upsertProject, shipProject } from './core/db.mjs';
import { sendMessage, getInbox, getOutbox, getMessage, markRead, markUnread, threadMessages, countsByAgent } from './core/mail.mjs';
import {
  upsertPersonality, deletePersonality, setPersonalityEnabled, setPersonalitySfw,
  setActivePersonality, setPersonalityFile,
  addCore, updateCore, deleteCore,
  addTrait, updateTrait, enableTrait, disableTrait, deleteTrait, promoteTraitToCore,
} from './core/personalities.mjs';
import { upsertScope, upsertScopePath, touchSessionFile } from './core/scopes.mjs';

// Bearer token auth for write endpoints. Absent token file → auth disabled
// (soft-fail, for dev flows). Token file path is env-configurable via
// WMEM_TOKEN_FILE; defaults to `./.wmem-token` in cwd so npm-install-and-run
// users can drop a file next to their install.
//
// Timing-safe comparison: Buffer.from both sides, length-mismatch short-
// circuit before the crypto compare (timingSafeEqual requires equal length).
// Minimum token length 32 bytes to reject trivial values.
const WMEM_TOKEN_FILE = process.env.WMEM_TOKEN_FILE || './.wmem-token';
let WMEM_TOKEN = null;
try {
  WMEM_TOKEN = readFileSync(WMEM_TOKEN_FILE, 'utf8').trim();
  if (WMEM_TOKEN.length < 32) WMEM_TOKEN = null;
} catch {}
const AUTH_ENFORCE = WMEM_TOKEN !== null;
console.log(`[wmem] auth: ${AUTH_ENFORCE ? `ENFORCE (token: ${WMEM_TOKEN_FILE})` : `disabled (no token at ${WMEM_TOKEN_FILE})`}`);

const WMEM_TOKEN_BUF = AUTH_ENFORCE ? Buffer.from(WMEM_TOKEN, 'utf8') : null;

function requireAuth(req, res, next) {
  if (!AUTH_ENFORCE) return next();
  const hdr = req.header('Authorization') || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  const presented = Buffer.from(token, 'utf8');
  const match =
    presented.length === WMEM_TOKEN_BUF.length &&
    timingSafeEqual(presented, WMEM_TOKEN_BUF);
  if (!match) {
    console.warn(`[wmem] auth denied: ${req.method} ${req.path} from ${req.ip} (caller=${req.caller || 'nil'})`);
    return res.status(401).json({ error: 'unauthorized', message: 'write endpoints require Bearer token' });
  }
  next();
}

const app = express();

// Port resolution: env var > wmem.config.json > default 18420.
// Default moved out of the 4200-4299 range (Angular CLI default) to reduce
// collisions on dev machines. Operators with their own preferences override
// via PORT env or wmem.config.json at repo root.
function resolvePort() {
  if (process.env.PORT) return parseInt(process.env.PORT, 10);
  try {
    const cfg = JSON.parse(readFileSync('./wmem.config.json', 'utf8'));
    if (cfg.port) return parseInt(cfg.port, 10);
  } catch {}
  return 18420;
}
const PORT = resolvePort();

app.use(express.json({ limit: '5mb' }));

// CORS — allow cross-origin from any caller; tighten at deploy-time via
// reverse-proxy if exposing publicly.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Caller');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Caller identity: X-Caller: <agent_id> on any HTTP request identifies the
// calling agent. Falls back to NULL if absent (graceful degradation —
// tools still work, they just don't stamp written_by).
app.use((req, res, next) => {
  req.caller = req.header('X-Caller') || null;
  next();
});

// ── Role gate: this instance must be 'master' to accept writes ──
//
// Multi-instance safety. When more than one wmem runs (one canonical + N
// mirrors), only the master accepts writes. Mirrors refuse with 403 so a
// misrouted client surfaces the misroute instead of silently forking the
// dataset.
//
// Role is stamped at first boot by migration 0010_wmem_role.sql based on:
//   - WMEM_ROLE env override (master | mirror | unknown)
//   - hostname autodetect (your-master-host → master)
//   - default 'unknown' (writes refused until operator sets role)
//
// Clients check GET /api/wmem/role before issuing writes, OR write through a
// local wmem-outbox daemon which buffers when the master is unreachable.
function getRole() {
  try {
    const row = getDb().prepare('SELECT role FROM wmem_role WHERE id = 1').get();
    return row?.role ?? 'unknown';
  } catch { return 'unknown'; }
}

// First-boot: seed wmem_role if empty. Default 'master' for single-user installs;
// operators running multi-instance topologies override via WMEM_ROLE=mirror|master
// before the service starts. The CHECK constraint in the schema prevents typos.
function seedRoleIfEmpty() {
  try {
    const db = getDb();
    const existing = db.prepare('SELECT role FROM wmem_role WHERE id = 1').get();
    if (existing) return;
    const role = process.env.WMEM_ROLE || 'master';
    const setBy = process.env.WMEM_ROLE ? 'env' : 'default-single-user';
    db.prepare(`INSERT INTO wmem_role (id, role, hostname, set_at, set_by, notes)
                VALUES (1, ?, ?, ?, ?, ?)`).run(
      role,
      process.env.HOSTNAME || 'unknown',
      Date.now(),
      setBy,
      role === 'master' ? 'auto-seeded; this instance accepts writes' : 'auto-seeded as mirror; writes will 403',
    );
    console.log(`[wmem] role seeded: ${role} (via ${setBy})`);
  } catch (err) {
    console.warn(`[wmem] role seed failed (migration 0010 may not have run yet): ${err.message}`);
  }
}
seedRoleIfEmpty();
function isWriteEndpoint(path) {
  if (!path) return false;
  if (path.startsWith('/api/ingest')) return true;
  if (path.startsWith('/api/amend')) return true;
  if (path.startsWith('/api/import')) return true;
  if (path.startsWith('/api/reimport')) return true;
  if (path.startsWith('/api/preferences/write')) return true;
  if (path.startsWith('/api/facts/write')) return true;
  if (path.startsWith('/api/capabilities/')) return true;
  if (path.startsWith('/api/mail/send')) return true;
  if (path === '/api/write') return true;
  return false;
}
app.use((req, res, next) => {
  if (req.method !== 'POST' || !isWriteEndpoint(req.path)) return next();
  const role = getRole();
  if (role === 'master') return next();
  return res.status(403).json({
    error: 'wmem_role_not_master',
    role,
    note: 'This wmem instance is not the canonical master. Writes refused. Send to the master instance or route via a wmem-outbox daemon.',
  });
});

// GET /api/wmem/role — clients SHOULD check this before sending writes; outbox
// daemons probe it on a timer to know when the upstream is master-and-writable.
app.get('/api/wmem/role', (req, res) => {
  try {
    const row = getDb().prepare('SELECT * FROM wmem_role WHERE id = 1').get();
    if (!row) return res.json({ role: 'unknown', writable: false, note: 'wmem_role table empty; service uninitialized' });
    res.json({
      role: row.role,
      writable: row.role === 'master',
      hostname: row.hostname,
      set_at: row.set_at,
      set_by: row.set_by,
      notes: row.notes,
    });
  } catch (err) {
    res.status(500).json({ role: 'unknown', writable: false, error: err.message });
  }
});

// ── POST /api/write — generic write dispatcher ──
//
// One endpoint, server-side allowlist. Adding a new write op = one line in
// WRITE_DISPATCH. The MCP client (or any HTTP caller) just sends
// { op: "namespace.verb", args: {...} } and the server routes it.
//
// All ops here go through the isMaster gate above. Unknown ops return 404
// with the full known_ops list for diagnosis.
const WRITE_DISPATCH = {
  // chunks
  'memory.amend':              args => amendChunk(args.chunk_id, args.new_content, args.reason),
  'memory.share':              args => shareChunk(args.chunk_id),
  'memory.personal':           args => markPersonal(args.chunk_id),
  // projects
  'project.upsert':            args => upsertProject(args),
  'project.ship':              args => shipProject(args.name, args.note),
  'project.scope.upsert':      args => upsertScope(args),
  'project.scope.path.upsert': args => upsertScopePath(args),
  // sessions
  'session.file.touch':        args => touchSessionFile(args),
  // personality registry
  'personality.upsert':        args => upsertPersonality(args),
  'personality.delete':        args => deletePersonality(args.id),
  'personality.enable':        args => setPersonalityEnabled(args.id, args.enabled),
  'personality.sfw':           args => setPersonalitySfw(args.id, args.sfw),
  'personality.activate':      args => setActivePersonality({ id: args.id, caller: args.caller, reason: args.reason }),
  'personality.file.set':      args => setPersonalityFile(args.personality, args.filename, args.content, args.alwaysLoad, args.sortOrder),
  // personality.core
  'personality.core.add':      args => addCore(args),
  'personality.core.update':   args => updateCore(args),
  'personality.core.delete':   args => deleteCore(args),
  // personality.trait
  'personality.trait.add':     args => addTrait(args),
  'personality.trait.update':  args => updateTrait(args),
  'personality.trait.enable':  args => enableTrait(args),
  'personality.trait.disable': args => disableTrait(args),
  'personality.trait.delete':  args => deleteTrait(args),
  'personality.trait.promote': args => promoteTraitToCore(args),
};

app.post('/api/write', requireAuth, (req, res) => {
  const { op, args } = req.body || {};
  if (typeof op !== 'string') {
    return res.status(400).json({ error: 'missing_op', note: 'body must be { op: "ns.verb", args: {...} }' });
  }
  const fn = WRITE_DISPATCH[op];
  if (!fn) {
    return res.status(404).json({ error: 'unknown_op', op, known_ops: Object.keys(WRITE_DISPATCH) });
  }
  try {
    const result = fn(args || {});
    res.json({ ok: true, op, result });
  } catch (err) {
    res.status(500).json({ error: err.message, op });
  }
});

// ── POST /api/ingest ──
// Store one or more chunks. Accepts single object or array.
// Body: { agent, sourceType, sourceId?, sessionId?, content, timestamp?, metadata? }
// Or: [ { ... }, { ... } ] for batch insert.
app.post('/api/ingest', requireAuth, (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const results = [];
  let inserted = 0;
  let deduped = 0;

  for (const item of items) {
    if (!item.agent || !item.sourceType || !item.content) {
      results.push({ error: 'missing agent, sourceType, or content' });
      continue;
    }
    const r = insertChunk({
      agent: item.agent,
      sourceType: item.sourceType,
      sourceId: item.sourceId || null,
      sessionId: item.sessionId || null,
      content: item.content,
      timestamp: item.timestamp || Date.now(),
      metadata: item.metadata || null,
    });
    if (r.deduped) deduped++; else inserted++;
    results.push(r);
  }

  res.json({ ok: true, inserted, deduped, total: items.length });
});

// ── GET /api/search ──
// FTS5 keyword search. Query params: q (required), agent, type, limit.
app.get('/api/search', (req, res) => {
  const { q, agent, type, limit } = req.query;
  if (!q) return res.status(400).json({ error: 'q parameter required' });

  try {
    const results = search(q, {
      agent: agent || undefined,
      sourceType: type || undefined,
      limit: parseInt(limit, 10) || 20,
    });

    res.json({
      query: q,
      count: results.length,
      results: results.map(r => ({
        id: r.id,
        agent: r.agent,
        sourceType: r.source_type,
        sourceId: r.source_id,
        sessionId: r.session_id,
        content: r.content,
        timestamp: r.timestamp,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
      })),
    });
  } catch (e) {
    // FTS5 query syntax errors (unbalanced quotes, etc)
    res.status(400).json({ error: `search failed: ${e.message}` });
  }
});

// ── GET /api/recent ──
// Recent chunks for a agent. Query params: agent (required), type, limit.
app.get('/api/recent', (req, res) => {
  const { agent, type, limit } = req.query;
  if (!agent) return res.status(400).json({ error: 'agent parameter required' });

  const results = getRecent(agent, {
    sourceType: type || undefined,
    limit: parseInt(limit, 10) || 50,
  });

  res.json({ agent, count: results.length, results });
});

// ── GET /api/stats ──
app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

// ───────────────────────────────────────────────────────────
// Mail — inter-agent messaging
// ───────────────────────────────────────────────────────────
// Caller identity from X-Caller header (already on req.caller).
// Request body `from` is accepted for backward-compat but X-Caller wins
// when both are present (header is authoritative).

// POST /api/mail/send — { to, body, subject?, parent_id?, metadata? }
// from = req.caller (X-Caller header), with fallback to req.body.from
app.post('/api/mail/send', requireAuth, (req, res) => {
  try {
    const from = req.caller || req.body?.from;
    if (!from) return res.status(400).json({ error: 'X-Caller header or body.from required' });
    const { to, body, subject, parent_id, metadata } = req.body || {};
    if (!to || !body) return res.status(400).json({ error: 'to and body required' });

    const meta = { source: req.header('X-Mail-Source') || 'direct-api', ...(metadata || {}) };
    const result = sendMessage({ from, to, body, subject, parentId: parent_id ?? null, metadata: meta });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/mail/inbox/:agent?unread=1&limit=N&since=<ms>
app.get('/api/mail/inbox/:agent', (req, res) => {
  try {
    const agent = req.params.agent;
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const limit = parseInt(req.query.limit, 10) || 100;
    const since = req.query.since ? parseInt(req.query.since, 10) : null;
    const rows = getInbox(agent, { unreadOnly, limit, since });
    res.json({ count: rows.length, messages: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mail/outbox/:agent
app.get('/api/mail/outbox/:agent', (req, res) => {
  try {
    const rows = getOutbox(req.params.agent, { limit: parseInt(req.query.limit, 10) || 100 });
    res.json({ count: rows.length, messages: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mail/:id — fetch a single message (numeric id)
app.get('/api/mail/:id', (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return next();  // let other routes try
  const msg = getMessage(id);
  if (!msg) return res.status(404).json({ error: 'not found' });
  res.json(msg);
});

// POST /api/mail/read/:id — mark read
app.post('/api/mail/read/:id', requireAuth, (req, res) => {
  const result = markRead(parseInt(req.params.id, 10));
  res.json(result);
});

// POST /api/mail/unread/:id — mark unread (useful for undo)
app.post('/api/mail/unread/:id', requireAuth, (req, res) => {
  const result = markUnread(parseInt(req.params.id, 10));
  res.json(result);
});

// POST /api/mail/reply/:id — shortcut: { body, subject?, metadata? }
// from = req.caller, to inferred from the parent message's from_agent
app.post('/api/mail/reply/:id', requireAuth, (req, res) => {
  try {
    const from = req.caller || req.body?.from;
    if (!from) return res.status(400).json({ error: 'X-Caller header or body.from required' });
    const parentId = parseInt(req.params.id, 10);
    const parent = getMessage(parentId);
    if (!parent) return res.status(404).json({ error: 'parent not found' });
    const { body, subject, metadata } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body required' });

    const meta = { source: req.header('X-Mail-Source') || 'direct-api', ...(metadata || {}) };
    const result = sendMessage({
      from,
      to: parent.from_agent, // reply goes back to sender
      body,
      subject: subject || (parent.subject ? `re: ${parent.subject}` : null),
      parentId,
      metadata: meta,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/mail/thread/:id — walk the whole thread containing this message
app.get('/api/mail/thread/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'numeric id required' });
  const rows = threadMessages(id);
  res.json({ count: rows.length, messages: rows });
});

// GET /api/mail/counts — per-agent inbox/outbox counts (for dashboards)
app.get('/api/mail/counts', (req, res) => {
  res.json(countsByAgent());
});

// ── Health ──
app.get('/health', (req, res) => {
  try {
    getDb(); // ensures DB is initialized
    res.json({ ok: true, port: PORT });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`wmem @ http://0.0.0.0:${PORT}`);
});
