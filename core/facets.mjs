/**
 * facets.mjs — Multi-axis facet extraction + scoring for retrieval.
 *
 * Extends the existing tag-boost pattern into a full facet bundle:
 *   - topic_tags   (from autotag.TOPIC_PATTERNS)
 *   - action_tags  (from autotag.ACTION_PATTERNS)
 *   - time_window  (from date refs in query)
 *   - project_hint (from project-name matches in query)
 *   - role_hint    (from "I said" / "X told me" / "you said" patterns)
 *
 * Same lift mechanism MemPalace gets from rooms (collapse search space
 * pre-scoring) but without single-bucket info loss — chunks live on
 * multiple axes naturally and score by axis overlap.
 *
 * Pure rule-based. No model calls. Fits the zero-LLM-infra rule.
 */

import { generateTags } from './autotag.mjs';

// ── Time-window extraction ──────────────────────────────────

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
                'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * Extract a {startMs, endMs} window from natural-language time refs in the query.
 * Returns null if no temporal anchor is found.
 *
 * Supports: explicit month/year ("april 2026"), bare month ("in april"),
 * bare year ("in 2026"), relative ("yesterday", "today", "last week",
 * "last month", "this week"), and ISO dates.
 */
export function extractTimeWindow(query, now = Date.now()) {
  const q = query.toLowerCase();
  const nowD = new Date(now);

  // ISO: 2026-05-17
  const iso = q.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const start = Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
    return { startMs: start, endMs: start + 86400000, label: iso[0] };
  }

  // Month + year: "april 2026"
  for (let i = 0; i < MONTHS.length; i++) {
    const re = new RegExp(`\\b${MONTHS[i]}\\s+(\\d{4})\\b`);
    const m = q.match(re);
    if (m) {
      const year = +m[1];
      const start = Date.UTC(year, i, 1);
      const end = Date.UTC(year, i + 1, 1);
      return { startMs: start, endMs: end, label: `${MONTHS[i]} ${year}` };
    }
  }

  // Bare month: "in april" / "during april" / "april ..." (assume current year)
  for (let i = 0; i < MONTHS.length; i++) {
    const re = new RegExp(`\\b${MONTHS[i]}\\b`);
    if (re.test(q)) {
      const year = nowD.getUTCFullYear();
      const start = Date.UTC(year, i, 1);
      const end = Date.UTC(year, i + 1, 1);
      return { startMs: start, endMs: end, label: MONTHS[i] };
    }
  }

  // Bare year
  const yr = q.match(/\b(20\d{2})\b/);
  if (yr) {
    const year = +yr[1];
    return { startMs: Date.UTC(year, 0, 1), endMs: Date.UTC(year + 1, 0, 1), label: yr[0] };
  }

  // Relative
  if (/\byesterday\b/.test(q)) {
    const end = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate());
    return { startMs: end - 86400000, endMs: end, label: 'yesterday' };
  }
  if (/\btoday\b/.test(q)) {
    const start = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate());
    return { startMs: start, endMs: start + 86400000, label: 'today' };
  }
  if (/\blast\s+week\b/.test(q)) {
    return { startMs: now - 14 * 86400000, endMs: now - 7 * 86400000, label: 'last week' };
  }
  if (/\bthis\s+week\b/.test(q)) {
    return { startMs: now - 7 * 86400000, endMs: now, label: 'this week' };
  }
  if (/\blast\s+month\b/.test(q)) {
    const m = nowD.getUTCMonth();
    const y = nowD.getUTCFullYear();
    return {
      startMs: Date.UTC(y, m - 1, 1),
      endMs: Date.UTC(y, m, 1),
      label: 'last month',
    };
  }

  return null;
}

// ── Role-hint extraction ────────────────────────────────────

/**
 * Returns 'user' / 'assistant' if the query implies one side of the conversation.
 *  - "what did I say" / "I told you" / "my preference"   → user
 *  - "what did you say" / "you told me" / "your"         → assistant
 *  - "X said" / "X told me" → user (third-party usually surfaces as user-side input)
 */
// Verb stems that count as reported speech (matched as prefix:
// "said"/"say"/"saying"/"says" all start with "say|sai", etc.)
const SPEECH_VERBS = /(say|said|tell|told|tells|ask|asked|asks|write|wrote|writes|mention|mentioned|mentions|wanted|prefer|prefers|recommend|recommended|suggested|suggest)/;

// First-person action verbs that also signal user-produced content.
const USER_ACTION_VERBS = /(decide|decided|decides|chose|choose|chooses|picked|pick|picks|want|wants|like|likes|love|loves|hate|hates|did|do|does)/;

export function extractRoleHint(query) {
  const q = query.toLowerCase();
  // First-person — user looking for their own input
  if (new RegExp(`\\bi\\s+${SPEECH_VERBS.source}\\b`).test(q)) return 'user';
  if (new RegExp(`\\bi\\s+${USER_ACTION_VERBS.source}\\b`).test(q)) return 'user';
  if (/\bmy\s+(preference|opinion|view|take)\b/.test(q)) return 'user';
  // Second-person — user looking for the assistant's prior output
  if (new RegExp(`\\byou\\s+${SPEECH_VERBS.source}\\b`).test(q)) return 'assistant';
  if (/\byour\s+(answer|response|take|view|opinion)\b/.test(q)) return 'assistant';
  // Third-party reported speech is usually captured as user-side context
  // ("nora said", "andreas mentioned") — but only if not first/second person.
  if (new RegExp(`\\b\\w+\\s+${SPEECH_VERBS.source}\\b`).test(q) &&
      !new RegExp(`\\b(i|you|we|they)\\s+${SPEECH_VERBS.source}\\b`).test(q)) {
    return 'user';
  }
  return null;
}

// ── Project-hint extraction ─────────────────────────────────

/**
 * Match query against a list of known project names. Returns matching
 * project names (lower-cased). Caller is responsible for providing the
 * project list (avoids a DB import dependency here).
 */
export function extractProjectHint(query, knownProjects = []) {
  if (!knownProjects.length) return [];
  const q = query.toLowerCase();
  const hits = [];
  for (const p of knownProjects) {
    if (!p) continue;
    const norm = String(p).toLowerCase();
    if (norm.length < 3) continue; // avoid noise from short names
    if (q.includes(norm)) hits.push(norm);
  }
  return hits;
}

// ── Bundle: query → facets ──────────────────────────────────

/**
 * Extract the full facet bundle for a query.
 * `opts.knownProjects` — array of project names to match project_hint against.
 * `opts.now` — current time (testing override).
 */
export function extractQueryFacets(query, opts = {}) {
  const tags = generateTags(query);
  const topicTags = tags.filter(t => isTopicTag(t.tag));
  const actionTags = tags.filter(t => isActionTag(t.tag));

  return {
    topic_tags: topicTags,
    action_tags: actionTags,
    time_window: extractTimeWindow(query, opts.now),
    project_hint: extractProjectHint(query, opts.knownProjects || []),
    role_hint: extractRoleHint(query),
  };
}

const ACTION_TAG_SET = new Set([
  'decision', 'fix', 'discovery', 'blocker', 'shipped', 'planning', 'review',
]);
function isActionTag(t) { return ACTION_TAG_SET.has(t); }
function isTopicTag(t) { return !ACTION_TAG_SET.has(t); }

// ── Scoring: chunk vs facet bundle ──────────────────────────

// Topic + action signal already lives in applyTagBoost (FTS path). Including
// them here would double-count and bias toward tag-noisy chunks. Facets only
// add NEW axes that the base retrieval can't express: temporal, project
// scope, and speaker role.
const W = {
  topic: 0,
  action: 0,
  time: 1.0,
  project: 0.8,
  role: 0.5,
};

/**
 * Score a single chunk against a facet bundle.
 *
 * @param {object} chunk - { id, content, timestamp, session_id, agent }
 * @param {object} ctx   - { chunkTagsById: Map<id, [{tag,confidence}]>,
 *                           chunkProjectById: Map<id, projectName> }
 * @param {object} facets
 * @returns {number} score in [0, ~3]; 0 = no facet match
 */
export function scoreChunkAgainstFacets(chunk, ctx, facets) {
  let score = 0;
  const chunkTags = (ctx.chunkTagsById && ctx.chunkTagsById.get(chunk.id)) || [];

  // Topic + action overlap (reuses existing tag intersection)
  if (facets.topic_tags && facets.topic_tags.length) {
    const sum = tagOverlap(facets.topic_tags, chunkTags);
    score += W.topic * sum;
  }
  if (facets.action_tags && facets.action_tags.length) {
    const sum = tagOverlap(facets.action_tags, chunkTags);
    score += W.action * sum;
  }

  // Time-window membership (binary)
  if (facets.time_window && chunk.timestamp) {
    const t = chunk.timestamp;
    if (t >= facets.time_window.startMs && t < facets.time_window.endMs) {
      score += W.time;
    }
  }

  // Project match (binary) — relies on caller pre-joining session_bookmarks
  if (facets.project_hint && facets.project_hint.length) {
    const proj = ctx.chunkProjectById && ctx.chunkProjectById.get(chunk.id);
    if (proj && facets.project_hint.includes(String(proj).toLowerCase())) {
      score += W.project;
    }
  }

  // Role (binary) — content prefix [user]/[assistant]
  if (facets.role_hint && chunk.content) {
    const prefix = chunk.content.startsWith('[user]') ? 'user'
      : chunk.content.startsWith('[assistant]') ? 'assistant' : null;
    if (prefix === facets.role_hint) score += W.role;
  }

  return score;
}

function tagOverlap(queryTags, chunkTags) {
  if (!chunkTags.length) return 0;
  const cMap = new Map(chunkTags.map(t => [t.tag, t.confidence]));
  let sum = 0;
  for (const q of queryTags) {
    const c = cMap.get(q.tag);
    if (c !== undefined) sum += q.confidence * c;
  }
  return sum;
}

// ── Debug helper ────────────────────────────────────────────

export function summarizeFacets(facets) {
  const parts = [];
  if (facets.topic_tags?.length) parts.push(`topics=${facets.topic_tags.map(t => t.tag).join(',')}`);
  if (facets.action_tags?.length) parts.push(`actions=${facets.action_tags.map(t => t.tag).join(',')}`);
  if (facets.time_window) parts.push(`time=${facets.time_window.label}`);
  if (facets.project_hint?.length) parts.push(`projects=${facets.project_hint.join(',')}`);
  if (facets.role_hint) parts.push(`role=${facets.role_hint}`);
  return parts.length ? parts.join(' | ') : '(no facets)';
}

export const FACET_WEIGHTS = W;
