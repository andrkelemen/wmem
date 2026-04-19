/**
 * context.mjs — Three-tier context compression with validation
 *
 * L1 (recent):   last 2 hours  — 500 chars per message (full texture)
 * L2 (mid):      2-6 hours     — 200 chars per message (conversation flow)
 * L3 (archival): 6-18 hours    — 80 chars per message  (decisions and turning points)
 * Beyond 18h:    dropped from context (still searchable via FTS5)
 *
 * Invariants:
 * - Every chunk belongs to exactly one tier based on age
 * - No chunk exists in multiple tiers
 * - Temporal order is preserved within each tier
 * - Compression is idempotent: running twice produces identical output
 * - Pure functions — no model calls, no side effects, no API cost
 */

const TIERS = [
  { name: 'L1', label: 'recent',   maxAge: 2 * 60 * 60 * 1000,  maxChars: 500 },
  { name: 'L2', label: 'mid',      maxAge: 6 * 60 * 60 * 1000,  maxChars: 200 },
  { name: 'L3', label: 'archival', maxAge: 18 * 60 * 60 * 1000, maxChars: 80 },
];

/**
 * Assign a chunk to its tier based on age.
 * Returns the tier object or null if beyond all tiers.
 */
export function assignTier(timestamp, now = Date.now()) {
  const age = now - (timestamp || 0);
  if (age < 0) return TIERS[0]; // future timestamps → treat as most recent
  return TIERS.find(t => age <= t.maxAge) || null;
}

/**
 * Classify an array of chunks into tiers.
 * Each chunk gets assigned exactly one tier. No overlaps.
 *
 * @param {Array} chunks - { content, timestamp, ... }
 * @param {number} now
 * @returns {{ L1: chunk[], L2: chunk[], L3: chunk[], dropped: chunk[] }}
 */
export function classifyChunks(chunks, now = Date.now()) {
  const result = { L1: [], L2: [], L3: [], dropped: [] };

  for (const chunk of chunks) {
    const tier = assignTier(chunk.timestamp, now);
    if (tier) {
      result[tier.name].push(chunk);
    } else {
      result.dropped.push(chunk);
    }
  }

  // Sort each tier by timestamp ascending (temporal order preserved)
  for (const key of ['L1', 'L2', 'L3']) {
    result[key].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  return result;
}

/**
 * Validate tier assignment integrity.
 * Returns issues if any chunk is in the wrong tier or appears in multiple tiers.
 */
export function validateTiers(classified, now = Date.now()) {
  const issues = [];
  const seenIds = new Set();

  for (const [tierName, chunks] of Object.entries(classified)) {
    if (tierName === 'dropped') continue;

    const tier = TIERS.find(t => t.name === tierName);
    if (!tier) continue;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const id = chunk.id || `${chunk.timestamp}-${i}`;

      // Check for duplicates across tiers
      if (seenIds.has(id)) {
        issues.push({ type: 'duplicate', chunk: id, tier: tierName });
      }
      seenIds.add(id);

      // Check tier assignment is correct
      const correctTier = assignTier(chunk.timestamp, now);
      if (correctTier && correctTier.name !== tierName) {
        issues.push({
          type: 'wrong_tier',
          chunk: id,
          assigned: tierName,
          correct: correctTier.name,
          age: now - chunk.timestamp,
        });
      }

      // Check temporal order within tier
      if (i > 0 && chunk.timestamp < chunks[i - 1].timestamp) {
        issues.push({ type: 'order_violation', tier: tierName, chunk: id });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Compress an array of chunks into a context block using time-based tiers.
 * Idempotent: running twice on the same input produces identical output.
 *
 * @param {Array} chunks - Array of { content, timestamp } objects
 * @param {number} now - Current timestamp in ms (default: Date.now())
 * @returns {string} Compressed context block
 */
export function compressContext(chunks, now = Date.now()) {
  if (!chunks || chunks.length === 0) return '';

  const classified = classifyChunks(chunks, now);
  const lines = [];

  // Process each tier in order: L1 (most detail) → L2 → L3
  for (const tier of TIERS) {
    const tierChunks = classified[tier.name];
    for (const chunk of tierChunks) {
      const content = chunk.content || '';
      const trimmed = content.length > tier.maxChars
        ? content.slice(0, tier.maxChars) + '...'
        : content;
      lines.push(trimmed);
    }
  }

  return lines.join('\n');
}

/**
 * Build a session summary from chunks belonging to one session.
 * Idempotent: same input always produces same output.
 *
 * @param {Array} chunks - Chunks from one session, ordered by timestamp ASC
 * @param {number} maxChars - Target character limit for the summary
 * @returns {string} Compressed session summary
 */
export function summarizeSession(chunks, maxChars = 500) {
  if (!chunks || chunks.length === 0) return '';

  // Deterministic selection: first, middle, last
  const first = chunks[0];
  const last = chunks[chunks.length - 1];
  const mid = chunks.length > 4 ? chunks[Math.floor(chunks.length / 2)] : null;

  const parts = [];
  const partLen = Math.floor(maxChars * 0.3);

  if (first.content) parts.push(first.content.slice(0, partLen));
  if (mid && mid.content) parts.push(mid.content.slice(0, partLen));
  if (last.content && last !== first) parts.push(last.content.slice(0, partLen));

  const joined = parts.join(' → ');
  return joined.length > maxChars ? joined.slice(0, maxChars) + '...' : joined;
}

/**
 * Get tier statistics for a set of chunks.
 */
export function getTierStats(chunks, now = Date.now()) {
  const classified = classifyChunks(chunks, now);
  return {
    L1: classified.L1.length,
    L2: classified.L2.length,
    L3: classified.L3.length,
    dropped: classified.dropped.length,
    total: chunks.length,
  };
}

export { TIERS };
