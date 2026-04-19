#!/usr/bin/env node
/*
  preference-loop-walkthrough.mjs — zero-LLM preference consolidation,
  end-to-end, in a single runnable script.

  The loop:
    1. Raw preference signals land as tier-1 rows (preference_signals-
       style writes via writePreference). Each row is a concrete moment
       the agent observed a preference cue.
    2. Consolidation: repeated signals about the same (agent, key) cluster
       by agent-side MCP tooling into tier-2 preferences with confidence
       derived from count + variance.
    3. Promotion: high-confidence preferences cross a threshold and get
       written as tier-3 facts via writeFact — stable identity statements
       that feed the L1 hot memory block every session.

  This script skips the MCP layer and calls core/ functions directly so
  you can watch every step print its result. Run it against a scratch DB:

    MEMORY_DB=/tmp/wmem-pref-demo.db node examples/preference-loop-walkthrough.mjs

  Observable output per stage lets you see the loop close instead of
  inferring it from documentation. Plug the same calls into your agent's
  MCP handlers (preferences_write / preferences_list / facts_write /
  facts_list / memory_l1) for the live-session version.
*/

import {
  upsertAgent,
  writePreference, listPreferences,
  writeFact, listFacts,
} from '../core/agents.mjs';

const AGENT = 'demo-agent';
const divider = (s) => console.log(`\n=== ${s} ===`);

// ─────────────────────────────────────────────────────────
// setup: clean slate for the demo
// ─────────────────────────────────────────────────────────
divider('setup');
upsertAgent({ id: AGENT, name: 'demo' });
console.log(`agent '${AGENT}' ready.`);

// ─────────────────────────────────────────────────────────
// stage 1 — tier-1 signals land as the agent observes cues
// ─────────────────────────────────────────────────────────
divider('stage 1: raw preference signals');

// The agent noticed three concrete moments where the user preferred
// terse answers. Each signal is its own row — append-only, high-volume.
const signals = [
  { key: 'reply_length', value: 'terse', source: 'user rebuffed a long prose answer' },
  { key: 'reply_length', value: 'terse', source: 'user praised the one-line answer' },
  { key: 'reply_length', value: 'terse', source: 'user cut a paragraph mid-read' },
  { key: 'citation_style', value: 'inline', source: 'user reformatted a footnote to inline' },
  { key: 'citation_style', value: 'inline', source: 'user dropped a "(see appendix)"' },
];
for (const s of signals) {
  writePreference({
    agentId: AGENT,
    key: s.key,
    value: s.value,
    signalType: 'observation',
    metadata: { source: s.source },
  });
  console.log(`  + signal: ${s.key}=${s.value}  (${s.source})`);
}
console.log(`${signals.length} signals written.`);

// ─────────────────────────────────────────────────────────
// stage 2 — inspect clustering as preferences accumulate
// ─────────────────────────────────────────────────────────
divider('stage 2: tier-2 view (preferences for the agent)');

const prefs = listPreferences({ agentId: AGENT });
// Group by key to show the consolidation shape the agent-side MCP
// tooling can produce.
const byKey = {};
for (const p of prefs) {
  byKey[p.key] ??= [];
  byKey[p.key].push(p);
}
for (const [key, rows] of Object.entries(byKey)) {
  const values = rows.map((r) => r.value);
  const uniqValues = [...new Set(values)];
  console.log(
    `  • ${key}: count=${rows.length}, distinct=${uniqValues.length}, values=${JSON.stringify(uniqValues)}`
  );
}
console.log(`(agent-side MCP logic would consolidate high-count + low-variance clusters into tier-3 facts.)`);

// ─────────────────────────────────────────────────────────
// stage 3 — promote consolidated preferences to tier-3 facts
// ─────────────────────────────────────────────────────────
divider('stage 3: fact promotion (tier-3)');

// In real use, the agent's consolidation logic would pick thresholds.
// For this demo, any key with >= 2 signals + single distinct value
// promotes.
const promoted = [];
for (const [key, rows] of Object.entries(byKey)) {
  const uniq = new Set(rows.map((r) => r.value));
  if (rows.length >= 2 && uniq.size === 1) {
    const value = rows[0].value;
    // Confidence as a crude proxy: 0.5 + 0.1 per additional signal, capped.
    const confidence = Math.min(0.5 + 0.1 * (rows.length - 1), 0.95);
    writeFact({
      agentId: AGENT,
      category: 'style',
      fact: `${key} = ${value}`,
      confidence,
    });
    promoted.push({ key, value, confidence, signalCount: rows.length });
    console.log(`  ↑ promoted: "${key} = ${value}"  (confidence ${confidence}, ${rows.length} signals)`);
  } else {
    console.log(`  — held: ${key}  (not consolidated — ${rows.length} signals, ${uniq.size} distinct values)`);
  }
}

// ─────────────────────────────────────────────────────────
// stage 4 — the agent's L1 hot block would now include these facts
// ─────────────────────────────────────────────────────────
divider('stage 4: tier-3 facts the agent carries forward');

const facts = listFacts({ agentId: AGENT });
if (facts.length === 0) {
  console.log('  (no promoted facts yet — write more signals to cross the threshold)');
} else {
  for (const f of facts) {
    console.log(`  ★ [${f.category}] ${f.fact}  (confidence ${f.confidence})`);
  }
}
console.log(
  `\nThese facts are what memory_l1 composes into the hot block for every session. `
  + `The agent's voice and routing decisions read them before the first user turn.`
);

// ─────────────────────────────────────────────────────────
// summary
// ─────────────────────────────────────────────────────────
divider('loop summary');
console.log(`
  tier 1 (signals):     ${signals.length} observations written
  tier 2 (preferences): ${prefs.length} rows across ${Object.keys(byKey).length} keys
  tier 3 (facts):       ${promoted.length} promoted

  Evolution is observable — run this script with more signals over
  time and watch facts accumulate. Swap the threshold logic in stage 3
  for your own consolidation policy (Bayesian confidence, EMA decay,
  etc.) — the underlying tier-1 + tier-2 + tier-3 tables carry whatever
  shape you prefer.
`);
