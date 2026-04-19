/**
 * preferences.mjs — Preference signal extraction from conversation text
 *
 * Extracts multidimensional preference signals:
 *   subject + context + sentiment
 *
 * "I like hotels with rooftop pools" →
 *   { subject: 'hotels', context: 'rooftop pools', sentiment: 0.85 }
 *
 * "I hate when my beer gets spilled" →
 *   { subject: 'beer', context: 'spilling', sentiment: 0.8, note: 'positive inferred from hate of loss' }
 *
 * Preferences are aggregations, not retrievals. GROUP BY, not SELECT.
 */

// ── Sentiment-bearing patterns ───────────────────────────────

const POSITIVE_PATTERNS = [
  { regex: /\bI\s+(?:really\s+)?(?:like|love|enjoy|prefer|adore)\s+(.+?)(?:\.|,|!|\band\b|$)/gi, sentiment: 0.85 },
  { regex: /\bI\s+always\s+(?:choose|pick|go\s+(?:for|with))\s+(.+?)(?:\.|,|!|$)/gi, sentiment: 0.8 },
  { regex: /\bI(?:'m| am)\s+(?:a\s+(?:big|huge)\s+)?fan\s+of\s+(.+?)(?:\.|,|!|$)/gi, sentiment: 0.85 },
  { regex: /\b(?:my|the)\s+favorite\s+(?:part|thing)\s+(?:is|about|was)\s+(.+?)(?:\.|,|!|$)/gi, sentiment: 0.9 },
  { regex: /\bI\s+(?:want|need|crave|miss)\s+(.+?)(?:\.|,|!|$)/gi, sentiment: 0.75 },
  { regex: /\bnothing\s+(?:beats|compares\s+to)\s+(.+?)(?:\.|,|!|$)/gi, sentiment: 0.9 },
  { regex: /\b(.+?)\s+(?:is|was|were)\s+(?:amazing|great|wonderful|fantastic|perfect|excellent|lovely|beautiful)\b/gi, sentiment: 0.9 },
  { regex: /\b(.+?)\s+(?:is|was|were)\s+(?:good|nice|fine|okay|decent|solid|pretty good)\b/gi, sentiment: 0.65 },
  { regex: /\bI\s+(?:really\s+)?(?:look\s+forward\s+to|can't\s+wait\s+for)\s+(.+?)(?:\.|,|!|$)/gi, sentiment: 0.8 },
];

const NEGATIVE_PATTERNS = [
  { regex: /\bI\s+(?:really\s+)?(?:hate|dislike|detest|loathe)\s+(.+?)(?:\.|,|!|$)/gi, sentiment: 0.15 },
  { regex: /\bI\s+(?:can'?t\s+stand|can'?t\s+bear|can'?t\s+handle)\s+(.+?)(?:\.|,|!|$)/gi, sentiment: 0.1 },
  { regex: /\bI\s+(?:never|don'?t)\s+(?:like|enjoy|eat|drink|use|go\s+to)\s+(.+?)(?:\.|,|!|$)/gi, sentiment: 0.2 },
  { regex: /\bI\s+(?:always\s+)?avoid\s+(.+?)(?:\.|,|!|$)/gi, sentiment: 0.15 },
  { regex: /\b(.+?)\s+(?:is|was|were)\s+(?:terrible|awful|horrible|disgusting|worst|dreadful)\b/gi, sentiment: 0.1 },
  { regex: /\bI(?:'m| am)\s+(?:allergic|intolerant)\s+to\s+(.+?)(?:\.|,|!|$)/gi, sentiment: 0.05 },
];

// ── Context extraction ───────────────────────────────────────

const CONTEXT_PATTERN = /\s+(?:with|at|on|near|by|in|from|during|for|about)\s+(.+?)$/i;

/**
 * Extract the subject and optional context from a matched phrase.
 * "hotels with rooftop pools" → { subject: 'hotels', context: 'rooftop pools' }
 * "beer" → { subject: 'beer', context: null }
 */
function extractSubjectContext(phrase) {
  const cleaned = phrase.trim()
    .replace(/^(?:a|an|the|my|some|any|having|going\s+to|being)\s+/i, '')
    .replace(/\s+(?:too|also|really|very|so)\s+/gi, ' ')
    .trim();

  if (!cleaned || cleaned.length < 2 || cleaned.length > 100) return null;

  const ctxMatch = cleaned.match(CONTEXT_PATTERN);
  if (ctxMatch) {
    const subject = cleaned.slice(0, ctxMatch.index).trim();
    const context = ctxMatch[1].trim();
    if (subject.length >= 2 && context.length >= 2) {
      return { subject: subject.toLowerCase(), context: context.toLowerCase() };
    }
  }

  return { subject: cleaned.toLowerCase(), context: null };
}

// ── Domain inference ─────────────────────────────────────────

const DOMAIN_KEYWORDS = {
  travel: /\b(?:hotels?|flights?|trips?|vacations?|travel|airports?|beach|resorts?|destinations?|cruises?|tourism|sightseeing|luggage|hiking)\b/i,
  food: /\b(?:foods?|cook|recipes?|restaurants?|meals?|dinners?|lunch|breakfast|eat|drinks?|beers?|wines?|cocktails?|coffees?|teas?|cuisine|chef|kitchen|sushi|espresso|baking)\b/i,
  entertainment: /\b(?:movies?|films?|shows?|series|books?|music|songs?|albums?|concerts?|games?|play|theater|podcasts?|stream|watch|read|listen|novels?|painting)\b/i,
  tech: /\b(?:phones?|laptops?|computers?|apps?|software|devices?|gadgets?|cameras?|headphones?|tablets?|monitors?|keyboards?)\b/i,
  fitness: /\b(?:exercise|workouts?|gym|running|yoga|sports?|hikes?|swim|bikes?|fitness|health|diets?|weights?)\b/i,
  home: /\b(?:houses?|apartments?|furniture|decor|gardens?|kitchen|bedroom|bathroom|cleaning|organize|renovate)\b/i,
  fashion: /\b(?:clothes|wear|dress|shoes?|style|outfits?|fashion|brands?|accessories|jewelry|hats?|bags?)\b/i,
  social: /\b(?:party|parties|friends?|gatherings?|events?|meetings?|dates?|hangouts?|celebrations?|weddings?|birthdays?)\b/i,
};

function inferDomain(text) {
  for (const [domain, pattern] of Object.entries(DOMAIN_KEYWORDS)) {
    if (pattern.test(text)) return domain;
  }
  return null;
}

// ── Main extraction ──────────────────────────────────────────

/**
 * Extract preference signals from a text chunk.
 * Only processes [user] messages — they contain self-statements.
 *
 * @param {string} content - Chunk content
 * @returns {Array<{subject, context, sentiment, domain, rawText}>}
 */
export function extractPreferences(content) {
  if (!content || content.length < 20) return [];
  if (!content.startsWith('[user]')) return [];

  const text = content.replace(/^\[user\]\s*/, '');
  const signals = [];

  for (const { regex, sentiment } of POSITIVE_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const phrase = match[1] || match[0];
      const parsed = extractSubjectContext(phrase);
      if (!parsed) continue;

      signals.push({
        subject: parsed.subject,
        context: parsed.context,
        sentiment,
        domain: inferDomain(phrase) || inferDomain(match[0]) || inferDomain(text),
        rawText: match[0].trim().slice(0, 200),
      });
    }
  }

  for (const { regex, sentiment } of NEGATIVE_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const phrase = match[1] || match[0];
      const parsed = extractSubjectContext(phrase);
      if (!parsed) continue;

      signals.push({
        subject: parsed.subject,
        context: parsed.context,
        sentiment,
        domain: inferDomain(phrase) || inferDomain(match[0]) || inferDomain(text),
        rawText: match[0].trim().slice(0, 200),
      });
    }
  }

  return signals;
}
