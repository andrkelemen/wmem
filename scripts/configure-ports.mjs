#!/usr/bin/env node
/**
 * configure-ports.mjs — interactive port picker for wmem service-mode.
 *
 * Probes candidate ports (try-bind a TCP socket), prompts the operator if
 * the default is taken, writes the result to wmem.config.json so both
 * server.mjs and modules/wmem-outbox/src/server.mjs pick it up at boot.
 *
 * Usage:
 *   node scripts/configure-ports.mjs                          # interactive
 *   node scripts/configure-ports.mjs --port 19420             # non-interactive
 *   node scripts/configure-ports.mjs --port 19420 --outbox-port 19421
 *   node scripts/configure-ports.mjs --no-outbox              # skip outbox
 *   node scripts/configure-ports.mjs --print                  # show current
 *
 * Only relevant for service-mode (`node server.mjs`). The single-user stdio
 * MCP (`node mcp-server.mjs`) does not use a port.
 */

import { createServer } from 'node:net';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const CONFIG_PATH = resolve(REPO_ROOT, 'wmem.config.json');

const DEFAULT_PORT        = 18420;
const DEFAULT_OUTBOX_PORT = 18421;

// ── arg parsing ───────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = { print: false, noOutbox: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port' && argv[i + 1])         flags.port = parseInt(argv[++i], 10);
  else if (argv[i] === '--outbox-port' && argv[i + 1]) flags.outboxPort = parseInt(argv[++i], 10);
  else if (argv[i] === '--no-outbox') flags.noOutbox = true;
  else if (argv[i] === '--print')     flags.print = true;
  else if (argv[i] === '--help' || argv[i] === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 18).join('\n'));
    process.exit(0);
  }
}

// ── helpers ───────────────────────────────────────────────────
function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

/** Try to bind a port. Resolves true if free, false if EADDRINUSE / EACCES. */
function isPortFree(port, host = '0.0.0.0') {
  return new Promise(resolveFn => {
    const srv = createServer();
    srv.once('error', () => resolveFn(false));
    srv.once('listening', () => srv.close(() => resolveFn(true)));
    srv.listen(port, host);
  });
}

/** Pick the first free port at or after `start`, scanning up to 50. */
async function findFreePort(start) {
  for (let p = start; p < start + 50; p++) {
    if (await isPortFree(p)) return p;
  }
  return null;
}

async function prompt(rl, question, defaultValue) {
  const ans = (await rl.question(`${question} [${defaultValue}]: `)).trim();
  return ans || String(defaultValue);
}

// ── main ──────────────────────────────────────────────────────
if (flags.print) {
  const cfg = readConfig();
  console.log(JSON.stringify({
    config_path: CONFIG_PATH,
    exists: existsSync(CONFIG_PATH),
    port:         cfg.port         ?? DEFAULT_PORT,
    outboxPort:   cfg.outboxPort   ?? DEFAULT_OUTBOX_PORT,
    upstreamHost: cfg.upstreamHost ?? '127.0.0.1',
    upstreamPort: cfg.upstreamPort ?? cfg.port ?? DEFAULT_PORT,
  }, null, 2));
  process.exit(0);
}

const existing = readConfig();
const finalCfg = { ...existing };

// SERVER PORT
let serverPort = flags.port ?? existing.port ?? DEFAULT_PORT;
const serverFree = await isPortFree(serverPort);

if (!serverFree && flags.port == null) {
  const suggested = await findFreePort(serverPort + 1);
  console.log(`⚠ port ${serverPort} is in use.`);
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    serverPort = parseInt(await prompt(rl, 'Use port', suggested ?? DEFAULT_PORT), 10);
    rl.close();
  } else if (suggested) {
    serverPort = suggested;
    console.log(`  auto-picked: ${serverPort} (non-interactive)`);
  } else {
    console.error('✗ no free port found in scan range');
    process.exit(1);
  }
} else if (flags.port == null && process.stdin.isTTY && !existing.port) {
  // interactive first-run: confirm default
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  serverPort = parseInt(await prompt(rl, 'wmem HTTP server port', serverPort), 10);
  rl.close();
}
finalCfg.port = serverPort;
console.log(`✓ server port: ${serverPort}`);

// OUTBOX PORT
if (!flags.noOutbox) {
  let outboxPort = flags.outboxPort ?? existing.outboxPort ?? DEFAULT_OUTBOX_PORT;
  const outboxFree = await isPortFree(outboxPort);

  if (!outboxFree && flags.outboxPort == null) {
    const suggested = await findFreePort(outboxPort + 1);
    console.log(`⚠ outbox port ${outboxPort} is in use.`);
    if (process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      outboxPort = parseInt(await prompt(rl, 'Use outbox port', suggested ?? DEFAULT_OUTBOX_PORT), 10);
      rl.close();
    } else if (suggested) {
      outboxPort = suggested;
      console.log(`  auto-picked: ${outboxPort} (non-interactive)`);
    }
  } else if (flags.outboxPort == null && process.stdin.isTTY && !existing.outboxPort) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    outboxPort = parseInt(await prompt(rl, 'wmem-outbox port', outboxPort), 10);
    rl.close();
  }
  finalCfg.outboxPort = outboxPort;
  console.log(`✓ outbox port: ${outboxPort}`);
}

// UPSTREAM (only relevant if running outbox against a remote master)
finalCfg.upstreamHost = existing.upstreamHost ?? '127.0.0.1';
finalCfg.upstreamPort = existing.upstreamPort ?? finalCfg.port;

writeConfig(finalCfg);
console.log(`\n✓ wrote ${CONFIG_PATH}`);
console.log('  server.mjs and modules/wmem-outbox/src/server.mjs will read this on next boot.');
console.log('  env vars (PORT, WMEM_OUTBOX_PORT, WMEM_UPSTREAM_*) still override the file.');
