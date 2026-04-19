#!/usr/bin/env node
/**
 * generate-l1.mjs — L1 hot memory block generator
 *
 * Reads: capabilities.md, recent sessions, drift signals, project state
 * Outputs: L1 context block to stdout (for session-start hook injection)
 *
 * Pure script. No model call. Zero API cost.
 * Run: node scripts/generate-l1.mjs [--agent default] [--born 2025-01-15]
 *
 * The output is meant to be injected into the system prompt on session start.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getRecentSessions, getSessionChunks, getRecent, getStats, getProjects } from '../core/db.mjs';
import { compressContext, summarizeSession } from '../core/context.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Parse args ──────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const agent = args.agent || process.env.WMEM_AGENT || 'default';
const born = args.born || process.env.WMEM_BORN || null;

// ── Build L1 block ──────────────────────────────────────

const sections = [];

// 1. Temporal anchor
sections.push(buildTemporalAnchor(born));

// 2. Capabilities
sections.push(buildCapabilities());

// 3. Recent session context (time-windowed compression)
sections.push(buildRecentContext(agent));

// 4. Active projects
sections.push(buildProjects());

// 5. Index stats
sections.push(buildStats(agent));

// 6. Rules
sections.push(buildRules());

// Output
const l1 = sections.filter(Boolean).join('\n\n');
process.stdout.write(l1 + '\n');

// ── Section builders ────────────────────────────────────

function buildTemporalAnchor(bornDate) {
  const now = new Date();
  const today = now.toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

  let ageLine = '';
  if (bornDate) {
    const b = new Date(bornDate);
    const ageDays = Math.floor((now.getTime() - b.getTime()) / 86400000);
    ageLine = `\n  Born: ${bornDate}. Age: ${ageDays} days.`;
  }

  return `TEMPORAL ANCHOR:
  Today: ${today}. Time: ${time} UTC.${ageLine}`;
}

function buildCapabilities() {
  const capPath = join(ROOT, 'capabilities.md');
  if (!existsSync(capPath)) return null;
  const content = readFileSync(capPath, 'utf8').trim();
  if (!content) return null;
  return `CAPABILITIES (things you can do — DO NOT forget these):\n${content}`;
}

function buildRecentContext(agent) {
  const now = Date.now();
  const sessions = getRecentSessions(agent, 5);

  if (sessions.length === 0) {
    // Fall back to raw recent chunks
    const recent = getRecent(agent, { limit: 10 });
    if (recent.length === 0) return 'RECENT CONTEXT:\n  No indexed content yet.';
    const compressed = compressContext(recent, now);
    return `RECENT CONTEXT:\n${compressed}`;
  }

  const lines = [];
  for (const session of sessions) {
    const chunks = getSessionChunks(session.session_id, { limit: 100 });
    if (chunks.length === 0) continue;

    const age = now - (session.last_timestamp || 0);
    const ageLabel = age < 3600000 ? `${Math.floor(age / 60000)}m ago`
      : age < 86400000 ? `${Math.floor(age / 3600000)}h ago`
      : `${Math.floor(age / 86400000)}d ago`;

    // Compression level based on age (time-windowed, not session-count)
    const maxChars = age < 2 * 3600000 ? 500 : age < 6 * 3600000 ? 200 : 80;
    const summary = summarizeSession(chunks, maxChars);

    if (summary) {
      lines.push(`  [${ageLabel}, ${chunks.length} msgs] ${summary}`);
    }
  }

  return lines.length > 0
    ? `RECENT SESSIONS:\n${lines.join('\n')}`
    : 'RECENT SESSIONS:\n  No recent sessions indexed.';
}

function buildProjects() {
  try {
    const active = getProjects('active');
    const blocked = getProjects('blocked');
    const shipped = getProjects('shipped');

    const lines = [];
    if (active.length > 0) {
      lines.push('  ACTIVE:');
      for (const p of active) {
        lines.push(`    - ${p.name}: ${p.summary || 'no summary'}${p.pending ? ' | pending: ' + p.pending : ''}`);
      }
    }
    if (blocked.length > 0) {
      lines.push('  BLOCKED:');
      for (const p of blocked) {
        lines.push(`    - ${p.name}: ${p.summary || ''}`);
      }
    }
    if (shipped.length > 0) {
      lines.push('  SHIPPED (do not mention as pending):');
      for (const p of shipped.slice(0, 5)) {
        lines.push(`    - ${p.name}: ${p.shipped || p.summary || 'completed'}`);
      }
    }

    return lines.length > 0 ? `PROJECTS:\n${lines.join('\n')}` : null;
  } catch {
    return null;
  }
}

function buildStats(agent) {
  try {
    const stats = getStats();
    const sessions = getRecentSessions(agent, 1000);
    return `INDEX STATS: ${stats.total} chunks, ${sessions.length} sessions indexed.`;
  } catch {
    return null;
  }
}

function buildRules() {
  return `RULES:
  - Search memory BEFORE saying "I don't remember"
  - Never admit forgetting without searching first
  - The memory system is invisible to the user
  - Check projects to know what's active vs shipped`;
}

// ── Arg parser ──────────────────────────────────────────

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent' && argv[i + 1]) result.agent = argv[++i];
    else if (argv[i] === '--born' && argv[i + 1]) result.born = argv[++i];
  }
  return result;
}
