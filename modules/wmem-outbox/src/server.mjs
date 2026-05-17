// server.mjs — HTTP listener: passthrough + outbox-on-error.
//
// Architecture (wmem multi-instance PR-D):
//   MCP client → POST localhost:18421/<path>
//                   ↓
//   [this daemon]
//                   ↓  try forward to upstream:18420/<path>
//   upstream reachable + 2xx        → pass response back verbatim
//   upstream reachable + 4xx        → pass response back verbatim (no buffer; caller bug)
//   upstream reachable + 5xx        → buffer in outbox.db, return 202+buffered
//   upstream unreachable / timeout  → buffer in outbox.db, return 202+buffered
//
// Reserved paths (not forwarded):
//   GET    /health
//   GET    /role
//   POST   /admin/drain
//   GET    /admin/outbox
//   DELETE /admin/outbox/dead-letter

import { createServer } from 'node:http';
import { openOutbox } from './outbox.mjs';
import { UpstreamProbe } from './probe.mjs';
import { Drain } from './drain.mjs';

const VERSION = '0.1.0';
const startedAt = Date.now();

// ─── config ─────────────────────────────────────────────────
// Port resolution: env > wmem.config.json > default. Defaults moved out of
// the 4200-4299 range (Angular CLI default) to reduce dev-machine collisions.
import { readFileSync as _readFileSync } from 'node:fs';
let _cfgFile = {};
try { _cfgFile = JSON.parse(_readFileSync('./wmem.config.json', 'utf8')); } catch {}

const cfg = {
  upstreamHost: process.env.WMEM_UPSTREAM_HOST ?? _cfgFile.upstreamHost ?? '127.0.0.1',
  upstreamPort: parseInt(process.env.WMEM_UPSTREAM_PORT ?? _cfgFile.upstreamPort ?? _cfgFile.port ?? '18420', 10),
  bind:    process.env.WMEM_OUTBOX_BIND ?? _cfgFile.outboxBind ?? '127.0.0.1',
  port:    parseInt(process.env.WMEM_OUTBOX_PORT ?? _cfgFile.outboxPort ?? '18421', 10),
  tickS:   parseFloat(process.env.WMEM_OUTBOX_TICK_S ?? '5'),
  batch:   parseInt(process.env.WMEM_OUTBOX_BATCH ?? '25', 10),
  deadLetterAfter: parseInt(process.env.WMEM_OUTBOX_DEAD_LETTER_AFTER ?? '12', 10),
  backoffBaseS:    parseFloat(process.env.WMEM_OUTBOX_BACKOFF_BASE_S ?? '30'),
  timeoutMs:       parseInt(process.env.WMEM_OUTBOX_TIMEOUT_MS ?? '3000', 10),
  probeS:          parseFloat(process.env.WMEM_OUTBOX_PROBE_S ?? '10'),
  logLevel:        process.env.LOG_LEVEL ?? 'info',
};
const UPSTREAM_URL = `http://${cfg.upstreamHost}:${cfg.upstreamPort}`;

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const logger = {
  debug: (...a) => LOG_LEVELS[cfg.logLevel] <= 0 && console.error('[debug]', ...a),
  info:  (...a) => LOG_LEVELS[cfg.logLevel] <= 1 && console.error('[info]', ...a),
  warn:  (...a) => LOG_LEVELS[cfg.logLevel] <= 2 && console.error('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
};

// ─── boot ───────────────────────────────────────────────────
logger.info(`wmem-outbox v${VERSION} starting on ${cfg.bind}:${cfg.port} → ${UPSTREAM_URL}`);
const outbox = openOutbox({ logger });
const probe  = new UpstreamProbe({ url: UPSTREAM_URL, timeoutMs: 2000, intervalMs: cfg.probeS * 1000, logger });
const drain  = new Drain({
  outbox, probe, upstreamUrl: UPSTREAM_URL, logger,
  opts: {
    tickIntervalMs: cfg.tickS * 1000,
    batch: cfg.batch,
    deadLetterAfter: cfg.deadLetterAfter,
    backoffBaseS: cfg.backoffBaseS,
    timeoutMs: cfg.timeoutMs,
  },
});

// startup role check — fail-loud-but-proceed
(async () => {
  await probe.checkReachable();
  await probe.checkRole();
  if (probe.state.role !== 'master') {
    logger.warn(`!! upstream role at startup is '${probe.state.role}' (NOT master). Daemon proceeds; isMaster gate will 403 writes if attempted.`);
  } else {
    logger.info(`upstream role: master ✓`);
  }
})();
probe.start();
drain.start();

// ─── helpers ────────────────────────────────────────────────
function jsonReply(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forwardHeaders(reqHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    const lower = k.toLowerCase();
    // strip transport-layer headers — fetch sets its own
    if (lower === 'host' || lower === 'content-length' || lower === 'connection') continue;
    // strip hop-by-hop
    if (lower === 'keep-alive' || lower === 'te' || lower === 'transfer-encoding') continue;
    // strip 'Expect: 100-continue' — undici (node fetch) rejects it, and we don't honor the contract
    if (lower === 'expect') continue;
    out[k] = v;
  }
  return out;
}

// ─── reserved endpoints ─────────────────────────────────────
const RESERVED = new Set(['/health', '/role', '/admin/drain', '/admin/outbox', '/admin/outbox/dead-letter']);

async function handleReserved(req, res, url) {
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    const counts = outbox.stats();
    return jsonReply(res, 200, {
      ok: true,
      upstream_reachable: probe.state.reachable,
      upstream_role: probe.state.role,
      outbox_pending: counts.pending,
      outbox_dead_letter: counts['dead-letter'],
      last_drain_ts: drain.last_drain_ts,
      last_drain_result: drain.last_drain_result,
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      version: VERSION,
    });
  }

  if (req.method === 'GET' && path === '/role') {
    return jsonReply(res, 200, {
      role: probe.state.role,
      writable: probe.state.role === 'master',
      upstream_reachable: probe.state.reachable,
      last_role_check_at: probe.state.last_role_check_at,
      stale: !probe.state.reachable,
    });
  }

  if (req.method === 'POST' && path === '/admin/drain') {
    await drain.tick();
    return jsonReply(res, 200, drain.snapshot());
  }

  if (req.method === 'GET' && path === '/admin/outbox') {
    return jsonReply(res, 200, {
      pending: outbox.listPending(),
      dead_letter: outbox.listDeadLetter(),
      stats: outbox.stats(),
    });
  }

  if (req.method === 'DELETE' && path === '/admin/outbox/dead-letter') {
    const purged = outbox.purgeDeadLetter();
    return jsonReply(res, 200, { ok: true, purged });
  }

  return jsonReply(res, 405, { error: 'method_not_allowed', path });
}

// ─── passthrough + buffer ───────────────────────────────────
async function handlePassthrough(req, res, url) {
  const targetPath = url.pathname + (url.search || '');
  const payload = await readRawBody(req);
  const headers = forwardHeaders(req.headers);

  let upstreamRes;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    upstreamRes = await fetch(`${UPSTREAM_URL}${targetPath}`, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : payload,
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (err) {
    // Transport failure → buffer (only for non-GET/HEAD, which are reads)
    if (req.method === 'GET' || req.method === 'HEAD') {
      return jsonReply(res, 503, {
        error: 'upstream_unreachable',
        note: 'GET/HEAD not buffered. Retry when upstream is reachable.',
      });
    }
    const id = outbox.enqueue({
      endpoint: targetPath,
      method: req.method,
      headers,
      payload,
      payloadType: req.headers['content-type'] || 'application/octet-stream',
    });
    logger.info(`[buffer] ${req.method} ${targetPath} → outbox id=${id} (transport: ${err.message} cause=${err.cause?.message ?? err.cause?.code ?? 'none'})`);
    res.writeHead(202, {
      'Content-Type': 'application/json',
      'X-Wmem-Outbox': 'buffered',
      'X-Wmem-Outbox-Id': String(id),
    });
    return res.end(JSON.stringify({ buffered: true, outbox_id: id, reason: 'upstream_unreachable' }));
  }

  // Buffer on 5xx too — server-side failure isn't caller's bug
  if (upstreamRes.status >= 500 && upstreamRes.status < 600 && req.method !== 'GET' && req.method !== 'HEAD') {
    const id = outbox.enqueue({
      endpoint: targetPath,
      method: req.method,
      headers,
      payload,
      payloadType: req.headers['content-type'] || 'application/octet-stream',
    });
    const errBody = await upstreamRes.text().catch(() => '');
    logger.info(`[buffer] ${req.method} ${targetPath} → outbox id=${id} (upstream ${upstreamRes.status}: ${errBody.slice(0,100)})`);
    res.writeHead(202, {
      'Content-Type': 'application/json',
      'X-Wmem-Outbox': 'buffered',
      'X-Wmem-Outbox-Id': String(id),
    });
    return res.end(JSON.stringify({ buffered: true, outbox_id: id, reason: 'upstream_5xx', upstream_status: upstreamRes.status }));
  }

  // Pass response verbatim (including 2xx, 3xx, 4xx)
  const respHeaders = {};
  upstreamRes.headers.forEach((v, k) => {
    if (k.toLowerCase() === 'transfer-encoding') return;
    respHeaders[k] = v;
  });
  res.writeHead(upstreamRes.status, respHeaders);
  const buf = Buffer.from(await upstreamRes.arrayBuffer());
  res.end(buf);
}

// ─── server ─────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (RESERVED.has(url.pathname)) {
      return await handleReserved(req, res, url);
    }
    return await handlePassthrough(req, res, url);
  } catch (err) {
    logger.error(`[server] unhandled error: ${err.stack || err.message}`);
    if (!res.headersSent) jsonReply(res, 500, { error: 'daemon_internal', message: err.message });
  }
});

server.listen(cfg.port, cfg.bind, () => {
  logger.info(`daemon up: ${cfg.bind}:${cfg.port} outbox_pending=${outbox.stats().pending}`);
});

// ─── graceful shutdown ──────────────────────────────────────
function shutdown(sig) {
  logger.info(`received ${sig}, shutting down`);
  probe.stop();
  drain.stop();
  server.close(() => {
    outbox.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
