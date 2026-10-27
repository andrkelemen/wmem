#!/usr/bin/env node
/**
 * SessionStart hook — emits the L1 hot block as additionalContext.
 *
 * Node port of session-start-hook.sh (#19). Behaviour is deliberately unchanged; what is
 * gone is the dependency on bash and on python3-for-JSON. JSON.stringify replaces a
 * python3 pipeline with a sed+awk fallback behind it, which is two escaping
 * implementations that could disagree — and the one that ran depended on the host.
 */
import { config, runScript, recordFire, resolveAgent } from './lib.mjs';

const cfg = config();

// 1. Active personality, read in-process. The shell spawned a node -e for this and then
//    three python3 processes to pick three fields out of its JSON.
let p = null;
try {
  const mod = await import('../../core/personality.mjs');
  const active = mod.getActivePersonality?.();
  if (active) p = { agent: active.name, born: active.born || null, l1: mod.buildPersonalityL1?.(active) || null };
} catch {}

const agent = await resolveAgent(cfg);   // shared with SessionEnd; see lib.mjs
const born = cfg.born || p?.born || null;

// 2. Incremental index. stdout is reserved for the hook's JSON, so this must stay quiet.
runScript('scripts/index-sessions.mjs', ['--dir', cfg.scanDir, '--agent', agent]);

// 3. The L1 block itself.
const l1Args = ['--agent', agent, '--directory', cfg.projectDir];
if (born) l1Args.push('--born', born);
const l1 = runScript('scripts/generate-l1.mjs', l1Args).stdout.trim();

const block = [p?.l1, l1].filter(Boolean).join('\n\n');
recordFire('SessionStart', { agent, bytes: block.length });

if (block) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: block },
  }) + '\n');
}
process.exit(0);
