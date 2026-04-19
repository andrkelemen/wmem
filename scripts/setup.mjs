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

import { existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir, platform as osPlatform } from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

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
}

// ── Helpers ─────────────────────────────────────────────

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
const wmemDb = join(WMEM_ROOT, 'data', 'memory.db');
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

const hasNodeModules = existsSync(join(WMEM_ROOT, 'node_modules', 'better-sqlite3'));
if (hasNodeModules) {
  ok('dependencies already installed');
} else if (flags.dryRun) {
  log('would run: npm install --production');
} else {
  log('running npm install (native modules will compile)...');
  run('npm install --production', { cwd: WMEM_ROOT });
  ok('dependencies installed');
}

// ── Step 4: Create data directory ───────────────────────

step(4, 'Setting up data directory');

const dataDir = join(WMEM_ROOT, 'data');
if (existsSync(dataDir)) {
  ok(`data/ exists`);
} else if (flags.dryRun) {
  log('would create data/');
} else {
  mkdirSync(dataDir, { recursive: true });
  ok('data/ created');
}

// Set DB path for all subsequent operations
process.env.MEMORY_DB = wmemDb;

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
const existing = getPersonality(agent);

if (existing) {
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

// ── Step 9: Verify ──────────────────────────────────────

step(9, 'Verification');

// Verify DB
const { getStats } = await import('../core/db.mjs');
const { getActivePersonality } = await import('../core/personality.mjs');

const stats = getStats();
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

if (stats.total > 0 && active) {
  console.log('\n✓ wmem is ready.\n');
} else if (flags.dryRun) {
  console.log('\n✓ dry run complete. run without --dry-run to apply.\n');
} else {
  console.log('\n⚠ setup finished with warnings — check above.\n');
}

console.log('Next steps:');
console.log(`  node scripts/personality.mjs show ${agent}     — customize personality`);
console.log(`  node scripts/generate-l1.mjs --agent ${agent}  — preview L1 block`);
console.log('  Start a new Claude Code session to activate wmem');
console.log('');
