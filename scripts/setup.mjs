#!/usr/bin/env node
/**
 * setup.mjs — One-command wmem setup
 *
 * 1. Detect OS (Linux/macOS/Windows)
 * 2. Find or verify node in PATH
 * 3. Run npm install in the wmem directory
 * 4. Create data/ dir if missing
 * 5. Import CLAUDE.md + existing .md files
 * 6. Index existing sessions
 * 7. Create personality
 * 8. Register via `claude mcp add` with platform-correct paths
 * 9. Verify with `claude mcp list`
 *
 * Usage:
 *   node scripts/setup.mjs --agent myname
 *   node scripts/setup.mjs --agent myname --born 2025-01-15
 *   node scripts/setup.mjs --dry-run
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir, platform as osPlatform } from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { resolveDbPath, splitWarning } from '../core/db-path.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WMEM_ROOT = resolve(__dirname, '..');
const PLATFORM = osPlatform();
const IS_WINDOWS = PLATFORM === 'win32';
const HOME = homedir();

// ── Parse args ──────────────────────────────────────────

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--agent' && argv[i + 1]) flags.agent = argv[++i];
  else if (argv[i] === '--claude-dir' && argv[i + 1]) flags.claudeDir = argv[++i];
  else if (argv[i] === '--born' && argv[i + 1]) flags.born = argv[++i];
  else if (argv[i] === '--dry-run') flags.dryRun = true;
  else if (argv[i] === '--scope' && argv[i + 1]) flags.scope = argv[++i];
  else if (argv[i] === '--db' && argv[i + 1]) flags.db = argv[++i];
}

// ── Helpers ─────────────────────────────────────────────

/**
 * Write one KEY=VALUE into ~/.wmemrc, keeping everything else in the file.
 *
 * This is the half that was missing. `loadRc()` has always read this file, and the MCP
 * server now reads it too — but nothing ever WROTE it, so the only channel that could
 * reconcile a hook process (no environment) with an MCP process (environment baked into
 * its registration) was permanently empty. A read side with no write side is not a
 * feature with a gap; it is a feature that has never once run.
 */
function upsertRc(key, value, rcPath = join(HOME, '.wmemrc')) {
  const line = `${key}="${value}"`;
  let lines = [];
  if (existsSync(rcPath)) lines = readFileSync(rcPath, 'utf8').split('\n');
  const re = new RegExp(`^(?:export\\s+)?${key}\\s*=`);
  const i = lines.findIndex(l => re.test(l.trim()));
  if (i >= 0) {
    if (lines[i].trim() === line) return { rcPath, changed: false };
    lines[i] = line;
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push('# written by wmem setup — the hooks and the MCP server both read this');
    lines.push(line);
  }
  writeFileSync(rcPath, lines.join('\n').replace(/\n*$/, '\n'));
  return { rcPath, changed: true };
}

function log(msg) { console.log(`  ${msg}`); }
function step(n, msg) { console.log(`\n[${n}] ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); }
function fail(msg) { console.error(`  ✗ ${msg}`); }

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit', ...opts }).trim();
  } catch (err) {
    if (opts.allowFail) return null;
    throw err;
  }
}

function runCapture(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch { return null; }
}

const agent = flags.agent || 'default';
const claudeDir = flags.claudeDir || join(HOME, '.claude');
const projectsDir = join(claudeDir, 'projects');
const claudeMd = join(claudeDir, 'CLAUDE.md');
// The database does NOT live in the install directory. WMEM_ROOT can be an npx cache or a
// node_modules folder that a reinstall deletes, and pinning it there is half of the split
// reported on 2026-10-27: setup baked <install>/data/memory.db into the MCP registration
// while the hooks, given no environment at all, used ~/.wmem/memory.db.
// One resolver decides, here and everywhere else, and an existing populated store wins so
// no one upgrading gets pointed at an empty file.
const dbResolution = flags.db
  ? { path: resolve(flags.db), source: 'flag', rejected: [] }
  : resolveDbPath({ env: { ...process.env, MEMORY_DB: undefined } });
const wmemDb = dbResolution.path;
const scope = flags.scope || 'user';

console.log('\nwmem setup\n');

// ── Step 1: Detect OS ───────────────────────────────────

step(1, 'Detecting environment');

const platformName = PLATFORM === 'win32' ? 'Windows' : PLATFORM === 'darwin' ? 'macOS' : 'Linux';
log(`platform: ${platformName}`);
log(`home: ${HOME}`);
log(`wmem: ${WMEM_ROOT}`);
log(`agent: ${agent}`);

if (flags.dryRun) log('mode: DRY RUN (no changes)');

// ── Step 2: Verify node ─────────────────────────────────

step(2, 'Checking node');

const nodeVersion = runCapture('node --version');
if (!nodeVersion) {
  fail('node not found in PATH. Install Node.js 18+ first.');
  process.exit(1);
}
const nodeMajor = parseInt(nodeVersion.replace('v', '').split('.')[0]);
if (nodeMajor < 18) {
  fail(`node ${nodeVersion} is too old. Node.js 18+ required.`);
  process.exit(1);
}
ok(`node ${nodeVersion}`);

const npmVersion = runCapture('npm --version');
if (npmVersion) ok(`npm ${npmVersion}`);

// Check claude CLI
const claudeVersion = runCapture('claude --version');
if (claudeVersion) {
  ok(`claude ${claudeVersion}`);
} else {
  warn('claude CLI not found — MCP registration will be skipped');
  warn('install: https://docs.anthropic.com/en/docs/claude-code');
}

// ── Step 3: npm install ─────────────────────────────────

step(3, 'Installing dependencies');

// ASK WHETHER IT RESOLVES, NOT WHETHER A DIRECTORY EXISTS AT A GUESSED PATH.
// This used to check `WMEM_ROOT/node_modules/better-sqlite3`, which is only where the
// dependency lives for a git clone. Installed from npm, node hoists it to the PARENT
// node_modules, so the check failed and setup ran `npm install --production` inside
// node_modules/wmem — installing into a package directory the host package manager owns.
// Resolution is the actual question: can this process import the module from here.
let hasNodeModules = false;
let depsFrom = null;
try {
  depsFrom = createRequire(import.meta.url).resolve('better-sqlite3');
  hasNodeModules = true;
} catch { }

if (hasNodeModules) {
  ok(`dependencies already installed`);
  log(`  via ${depsFrom.replace(/\/node_modules\/better-sqlite3\/.*$/, '/node_modules')}`);
} else if (flags.dryRun) {
  log('would run: npm install --production');
} else {
  log('running npm install (native modules will compile)...');
  run('npm install --production', { cwd: WMEM_ROOT });
  ok('dependencies installed');
}

// ── Step 4: Create data directory ───────────────────────

step(4, 'Setting up data directory');

const dataDir = dirname(wmemDb);
if (existsSync(dataDir)) {
  ok(`${dataDir} exists`);
} else if (flags.dryRun) {
  log(`would create ${dataDir}`);
} else {
  mkdirSync(dataDir, { recursive: true });
  ok(`${dataDir} created`);
}

// Set DB path for all subsequent operations
process.env.MEMORY_DB = wmemDb;
ok(`database: ${wmemDb}  (${dbResolution.source})`);
{
  const w = splitWarning(dbResolution);
  if (w) { warn('more than one wmem database holds data'); console.log(w); }
}

// Persist it where BOTH halves look. Without this the hooks get no environment at all and
// fall back to their own default — which is exactly how the store split.
if (flags.dryRun) {
  log(`would write MEMORY_DB to ${join(HOME, '.wmemrc')}`);
} else {
  const rc = upsertRc('MEMORY_DB', wmemDb);
  ok(rc.changed ? `MEMORY_DB written to ${rc.rcPath}` : `MEMORY_DB already correct in ${rc.rcPath}`);
}

// ── Step 5: Import existing files ───────────────────────

step(5, 'Importing existing files');

if (existsSync(claudeMd)) {
  const { importMarkdown, importFile } = await import('../core/importer.mjs');

  if (flags.dryRun) {
    const preview = importMarkdown(claudeMd, agent, { dryRun: true });
    ok(`CLAUDE.md: ${preview.sections} sections, ${preview.flagged.length} flagged`);
    preview.classified.forEach(c => {
      const icon = c.confidence < 0.5 ? '⚠' : '✓';
      log(`  ${icon} [${c.type.padEnd(11)}] ${c.section?.slice(0, 45)}`);
    });
  } else {
    const result = importMarkdown(claudeMd, agent);
    ok(`CLAUDE.md: ${result.sections} sections → ${result.chunks} chunks (${result.flagged.length} flagged)`);
  }

  // Import other .md files
  const extraMd = readdirSync(claudeDir).filter(f => f.endsWith('.md') && f !== 'CLAUDE.md' && f !== 'MEMORY.md');
  for (const f of extraMd) {
    const fullPath = join(claudeDir, f);
    if (flags.dryRun) {
      log(`  would import: ${f}`);
    } else {
      try {
        const r = importFile(fullPath, agent);
        if (r.imported) ok(`${f}: imported`);
      } catch (err) {
        warn(`${f}: ${err.message}`);
      }
    }
  }
} else {
  warn('no CLAUDE.md found — skipping import');
}

// ── Step 6: Index sessions ──────────────────────────────

step(6, 'Indexing sessions');

if (existsSync(projectsDir)) {
  const { indexSessions } = await import('../core/indexer.mjs');

  if (flags.dryRun) {
    log(`would scan: ${projectsDir}`);
  } else {
    const result = await indexSessions({ dir: projectsDir, agent, verbose: false });
    ok(`${result.indexed} files, ${result.newChunks} chunks, ${result.newSessions} sessions, ${result.skipped} skipped`);
    if (result.errors > 0) warn(`${result.errors} errors during indexing`);
  }
} else {
  warn(`no sessions directory at ${projectsDir}`);
}

// ── Step 7: Create personality ──────────────────────────

step(7, 'Setting up personality');

const { getPersonality, createPersonality, activatePersonality } = await import('../core/personality.mjs');

// READING OPENS THE DATABASE, AND OPENING IT CREATES IT. This lookup ran unconditionally,
// so `wmem init --dry-run` on a machine with no wmem yet left a real store (and its WAL
// files) behind while reporting "no changes". Found by installing the packed tarball
// against an empty HOME and listing what appeared. On a machine that already has a
// database, reading is harmless and makes the dry run more useful — so ask only then.
const dbExistsAlready = existsSync(wmemDb);
const existing = (!flags.dryRun || dbExistsAlready) ? getPersonality(agent) : null;

if (flags.dryRun && !dbExistsAlready) {
  log(`would create personality: ${agent}  (no database yet, so nothing was read)`);
} else if (existing) {
  ok(`personality "${agent}" exists`);
  if (!flags.dryRun) activatePersonality(agent);
  ok('activated');
} else if (flags.dryRun) {
  log(`would create personality: ${agent}`);
} else {
  createPersonality({
    name: agent,
    displayName: agent,
    description: `${agent} agent`,
    systemPrompt: '',
    voice: '',
    capabilities: [],
    born: flags.born || null,
  });
  activatePersonality(agent);
  ok(`personality "${agent}" created and activated`);
}

// ── Step 8: Register MCP via claude CLI ─────────────────

step(8, 'Registering MCP server');

// Normalize paths — forward slashes work on all platforms including Windows Git Bash
const mpcPath = join(WMEM_ROOT, 'mcp-server.mjs').replace(/\\/g, '/');
const dbPath = wmemDb.replace(/\\/g, '/');
const addCmd = `claude mcp add -s user wmem -e "MEMORY_DB=${dbPath}" -- node "${mpcPath}"`;

if (!claudeVersion) {
  warn('claude CLI not available — skipping MCP registration');
  log(`manual setup: ${addCmd}`);
} else {
  // Check if already registered
  const mcpList = runCapture('claude mcp list');
  const alreadyRegistered = mcpList && mcpList.includes('wmem');

  if (alreadyRegistered) {
    ok('wmem already registered');
    log('to re-register: claude mcp remove wmem -s user && then re-run setup');
  } else if (flags.dryRun) {
    log(`would run: ${addCmd}`);
  } else {
    log('registering wmem MCP server...');
    const result = runCapture(addCmd);
    if (result !== null) {
      ok('wmem MCP server registered (scope: user)');
    } else {
      warn('MCP registration failed — try manually:');
      log(`  ${addCmd}`);
    }
  }
}

// ── Step 9: Register session hooks ──────────────────────

step(9, 'Registering session hooks');

const hookSettingsPath = join(claudeDir, 'settings.json');

if (flags.dryRun) {
  log(`would register SessionStart + SessionEnd hooks in ${hookSettingsPath}`);
} else {
  try {
    const result = run(`node "${join(WMEM_ROOT, 'scripts', 'register-hooks.mjs')}" --settings "${hookSettingsPath}"`, { silent: true });
    ok('SessionStart + SessionEnd hooks registered');
    log('  hooks fire on next session: incremental index, preference enqueue, bookmark + KG materialization');
  } catch (err) {
    warn('hook registration failed — manual install:');
    log(`  node ${join(WMEM_ROOT, 'scripts', 'register-hooks.mjs')}`);
  }
}

// ── Step 10: Verify ─────────────────────────────────────

step(10, 'Verification');

// A DRY RUN MUST NOT WRITE. This block opens the database — which creates the file and
// applies migrations — and it ran unconditionally, so `wmem init --dry-run` on a clean
// machine left a real store behind and still called itself "no changes". Found by running
// the packed tarball against an empty HOME and then listing what appeared in it. A report
// that does not match what happened is the defect this whole release is about.
if (flags.dryRun) {
  log('would open the database, apply migrations and verify the MCP registration');
  log('(skipped: this is a dry run, and opening the database would create it)');
  console.log('\nwmem setup complete (dry run — nothing was changed)\n');
  process.exit(0);
}

// Verify DB
const { getStats } = await import('../core/db.mjs');
const { getActivePersonality } = await import('../core/personality.mjs');

// The native module LOADS, not merely exists. Step 3 checks for the better-sqlite3
// directory, which is present even when the prebuilt binary was compiled for a different
// node ABI — in that case require() throws and every later step fails with a confusing
// error far from the cause. Opening the database is also what applies migrations, so this
// one call proves both at once and names the real problem if it fails.
let stats, tableCount = 0;
try {
  const { getDb } = await import('../core/db.mjs');
  tableCount = getDb().prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table'").get().c;
  ok(`database opens — ${tableCount} tables, migrations applied`);
} catch (e) {
  fail(`database will not open: ${e.message}`);
  log('better-sqlite3 is a native module; on a fresh host this usually means it needs');
  log('rebuilding for your node version:  npm rebuild better-sqlite3');
  process.exit(1);
}

stats = getStats();
const active = getActivePersonality();

ok(`chunks: ${stats.total}`);
ok(`personality: ${active?.name || 'none'}`);
ok(`DB: ${wmemDb}`);

// Verify MCP if claude is available
if (claudeVersion && !flags.dryRun) {
  log('verifying MCP connection...');
  const list = runCapture('claude mcp list');
  if (list && list.includes('wmem')) {
    const wmemLine = list.split('\n').find(l => l.includes('wmem'));
    if (wmemLine && wmemLine.includes('Connected')) {
      ok('wmem MCP: connected');
    } else if (wmemLine) {
      log(`  wmem MCP: ${wmemLine.trim()}`);
    }
  }
}

// ── Done ────────────────────────────────────────────────

// SUCCESS IS NOT "THERE IS ALREADY DATA". This read `stats.total > 0 && active`, so a
// brand-new machine with no CLAUDE.md and no prior sessions — the exact state of a first
// install — finished with "setup finished with warnings — check above", where the two
// things above were "no CLAUDE.md found" and "no sessions directory". Nothing was wrong.
// An empty store on day one is the correct outcome, and telling a first-time user their
// install is suspect is first contact on a release whose thesis is download-and-run.
//
// What actually has to be true: the database opened, migrations applied, a personality is
// active. Those are asserted above and we would not be here otherwise.
if (flags.dryRun) {
  console.log('\n✓ dry run complete. run without --dry-run to apply.\n');
} else if (active) {
  console.log('\n✓ wmem is ready.\n');
  if (stats.total === 0) {
    console.log('Nothing existing to import — no CLAUDE.md and no prior sessions found.');
    console.log('That is normal on a new machine. wmem starts recording from your next session.\n');
  }
} else {
  console.log('\n⚠ setup finished without an active personality — check above.\n');
}

// Commands a person can actually paste. `node scripts/...` is only runnable from a git
// clone; installed from npm these live inside node_modules and that path is not where the
// reader is standing. Same defect as the reimport usage lines fixed in 1.3.3 — advice that
// works on the author's machine is not advice.
console.log('Check the hooks actually fired, not just that they registered:');
console.log('  wmem doctor --hooks');
console.log('');
console.log('Next steps:');
console.log(`  node ${join(WMEM_ROOT, 'scripts', 'personality.mjs')} show ${agent}`);
console.log(`  node ${join(WMEM_ROOT, 'scripts', 'generate-l1.mjs')} --agent ${agent}`);
console.log('  Start a new Claude Code session to activate wmem');
console.log('');
