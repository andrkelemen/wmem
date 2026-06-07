/**
 * http-adapter.mjs — route reads through a remote wmem service over HTTP.
 *
 * When `WMEM_HTTP_URL` is set (e.g. `http://wmem.lan:4080`), wmem's MCP server
 * stops reading from the local SQLite and instead asks the remote service.
 * This lets multi-machine setups share one canonical wmem without each
 * client needing its own DB file.
 *
 * Local mode (default): use core/db.mjs functions directly — zero overhead.
 * HTTP mode: thin wrappers around fetch() that mimic the db.mjs signatures
 *            and return the same shapes the local handlers would return.
 *
 * Only READ paths route through here. Writes stay local-only for now —
 * `WMEM_HTTP_WRITES` could opt in to remote writes in a future cycle, but
 * write-through has bigger consistency questions (auth, conflict, sync)
 * that aren't worth solving for v1.3.
 *
 * Pattern: mcp-server.mjs imports `getReadBackend()` once at startup and
 * destructures the read functions. The returned object is one of:
 *   - { mode: 'local', search, getRecent, getStats, ... }
 *   - { mode: 'http',  search, getRecent, getStats, ... }  (this file)
 *
 * Either way the call sites are unchanged — pure module-level switching.
 */

import * as localDb from './db.mjs';

const READ_FUNCTIONS = ['search', 'getRecent', 'getStats'];

function joinUrl(base, path) {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  return `${b}/${p}`;
}

function buildQueryString(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

async function httpGet(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`wmem HTTP ${res.status} on ${url}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function makeHttpAdapter(baseUrl) {
  const sleepMaxMs = Number(process.env.WMEM_HTTP_TIMEOUT_MS || 15000);

  async function httpGetWithTimeout(path, params = {}) {
    const url = joinUrl(baseUrl, path) + buildQueryString(params);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), sleepMaxMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`wmem HTTP ${res.status} on ${url}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    mode: 'http',
    baseUrl,

    // search(query, { agent, sourceType, limit }) → matches local shape
    async search(query, opts = {}) {
      const data = await httpGetWithTimeout('/api/search', {
        q: query,
        agent: opts.agent,
        type: opts.sourceType,
        limit: opts.limit,
      });
      // server returns { query, count, results: [...] } — local search returns
      // bare array. Normalize to array so call sites don't have to branch.
      return Array.isArray(data) ? data : (data.results || []);
    },

    // getRecent(agent, { sourceType, limit }) → array
    async getRecent(agent, opts = {}) {
      const data = await httpGetWithTimeout('/api/recent', {
        agent,
        type: opts.sourceType,
        limit: opts.limit,
      });
      return Array.isArray(data) ? data : (data.results || []);
    },

    // getStats() → object (same shape both modes)
    async getStats() {
      return httpGetWithTimeout('/api/stats');
    },
  };
}

/**
 * Resolve the read backend at process start. Pure switch:
 *   WMEM_HTTP_URL unset → local (sync, zero overhead, same as before v1.3 #84)
 *   WMEM_HTTP_URL set   → http (async fetch wrappers, base from env)
 *
 * Callers should destructure once at module load:
 *   const { search, getRecent, getStats } = getReadBackend();
 *
 * Note: HTTP-mode read functions return Promises; the local ones are sync.
 * Call sites that previously used the sync path must add `await` when the
 * backend is HTTP. mcp-server.mjs uses await-friendly code so this works
 * transparently; the handlers are already async.
 */
export function getReadBackend() {
  const url = process.env.WMEM_HTTP_URL;
  if (!url) {
    return {
      mode: 'local',
      baseUrl: null,
      search: localDb.search,
      getRecent: localDb.getRecent,
      getStats: localDb.getStats,
    };
  }
  const adapter = makeHttpAdapter(url);
  return adapter;
}

export { READ_FUNCTIONS };
