/**
 * subquery.mjs — Sub-query splitting for multi-event questions
 *
 * "How many days between museum visit and concert?"
 * → ["museum visit", "concert"]
 * → search each independently
 * → merge results per sub-query
 *
 * Three temporal sub-types:
 *   single-event:  "how many weeks ago did I buy X?" → find X, calc from now
 *   multi-event:   "how many days between X and Y?" → find X, find Y, compare
 *   ordering:      "what order: X, Y, Z?" → find all, sort by timestamp
 */

/**
 * Detect if a question needs sub-query splitting.
 * Returns { needsSplit, type, events[] }
 */
export function detectSubQueries(question) {
  const q = question.toLowerCase();

  // Multi-event: "between X and Y", "from X to Y"
  const betweenMatch = question.match(/between\s+(?:the\s+)?(?:day\s+)?(?:I\s+)?(.+?)\s+and\s+(?:the\s+)?(?:day\s+)?(?:I\s+)?(.+?)[\?\.]/i);
  if (betweenMatch) {
    return {
      needsSplit: true,
      type: 'multi-event',
      events: [cleanEvent(betweenMatch[1]), cleanEvent(betweenMatch[2])],
    };
  }

  // Ordering: "order of X, Y, and Z" or "which happened first, X or Y"
  const orderMatch = question.match(/order\s+(?:of\s+)?(?:the\s+)?(?:three\s+|two\s+)?(?:events?\s*:?\s*)?(.+?)[\?\.]/i);
  if (orderMatch) {
    const events = splitEventList(orderMatch[1]);
    if (events.length >= 2) {
      return { needsSplit: true, type: 'ordering', events };
    }
  }

  const firstMatch = question.match(/which\s+(?:event\s+)?happened\s+first\s*,?\s*(.+?)\s+or\s+(.+?)[\?\.]/i);
  if (firstMatch) {
    return {
      needsSplit: true,
      type: 'ordering',
      events: [cleanEvent(firstMatch[1]), cleanEvent(firstMatch[2])],
    };
  }

  // Single-event with duration: "how many days/weeks/months ago did I X"
  const agoMatch = question.match(/how\s+(?:many|long)\s+(?:days?|weeks?|months?)\s+(?:ago\s+)?(?:did\s+I\s+|since\s+I\s+|have\s+I\s+)(.+?)[\?\.]/i);
  if (agoMatch) {
    return {
      needsSplit: true,
      type: 'single-event',
      events: [cleanEvent(agoMatch[1])],
    };
  }

  // "How many days did I spend on X"
  const spendMatch = question.match(/how\s+(?:many|long)\s+(?:days?|weeks?|months?)\s+(?:did\s+I\s+|in\s+total\s+)?(?:spend|spent)\s+(?:on\s+)?(.+?)[\?\.]/i);
  if (spendMatch) {
    return {
      needsSplit: true,
      type: 'single-event',
      events: [cleanEvent(spendMatch[1])],
    };
  }

  // "How many days passed since X"
  const sinceMatch = question.match(/(?:passed|elapsed)\s+since\s+(?:I\s+)?(.+?)[\?\.]/i);
  if (sinceMatch) {
    return {
      needsSplit: true,
      type: 'single-event',
      events: [cleanEvent(sinceMatch[1])],
    };
  }

  // Generic "how long" with a specific event
  const howLongMatch = question.match(/how\s+long\s+(?:was\s+I|did\s+I|have\s+I\s+been)\s+(.+?)[\?\.]/i);
  if (howLongMatch) {
    return {
      needsSplit: true,
      type: 'single-event',
      events: [cleanEvent(howLongMatch[1])],
    };
  }

  // "How many days did it take me to X"
  const takeMeMatch = question.match(/how\s+(?:many|long)\s+(?:days?|weeks?|months?)\s+did\s+it\s+take\s+(?:me\s+)?to\s+(.+?)[\?\.]/i);
  if (takeMeMatch) {
    return { needsSplit: true, type: 'single-event', events: [cleanEvent(takeMeMatch[1])] };
  }

  // "Which X did I Y most recently" or "Which X did I Y first"
  const whichFirstMatch = question.match(/which\s+(.+?)\s+did\s+I\s+(.+?)\s+(most recently|first|last|latest|earliest)[\?,\.]/i);
  if (whichFirstMatch) {
    return { needsSplit: true, type: 'single-event', events: [cleanEvent(whichFirstMatch[1] + ' ' + whichFirstMatch[2])] };
  }

  // "Who X first, second, third among A, B, C"
  const whoOrderMatch = question.match(/who\s+(.+?)\s+(?:first|second|third).+?(?:among|:)\s*(.+?)[\?\.]/i);
  if (whoOrderMatch) {
    const events = splitEventList(whoOrderMatch[2]);
    if (events.length >= 2) return { needsSplit: true, type: 'ordering', events };
  }

  // "Which X did I Y first, A or B"
  const whichOrMatch = question.match(/which\s+(.+?)\s+did\s+I\s+(.+?)\s+first\s*,\s*(.+?)\s+or\s+(.+?)[\?\.]/i);
  if (whichOrMatch) {
    return { needsSplit: true, type: 'ordering', events: [cleanEvent(whichOrMatch[3]), cleanEvent(whichOrMatch[4])] };
  }

  // "What is the order of X I Y from earliest to latest"
  const orderOfMatch = question.match(/(?:what\s+is\s+)?the\s+order\s+of\s+(?:the\s+)?(.+?)\s+(?:I|from)\s+(.+?)[\?\.]/i);
  if (orderOfMatch) {
    return { needsSplit: true, type: 'ordering', events: [cleanEvent(orderOfMatch[1])] };
  }

  // "I mentioned/did X [time ago]. What/Who..."
  const mentionedMatch = question.match(/I\s+(?:mentioned|did|received|went|participated)\s+(.+?)\s+(?:last|two|three|\d+)\s+(?:weeks?|days?|months?|saturday|sunday|monday|tuesday|wednesday|thursday|friday)\s*(?:ago)?/i);
  if (mentionedMatch) {
    return { needsSplit: true, type: 'single-event', events: [cleanEvent(mentionedMatch[1])] };
  }

  // "What X did I do/Y [time ago]?"
  const whatTimeMatch = question.match(/what\s+(.+?)\s+did\s+I\s+(.+?)\s+(?:last|two|three|\d+)\s+(?:weeks?|days?|months?|ago|saturday|sunday|monday|tuesday|wednesday|thursday|friday)/i);
  if (whatTimeMatch) {
    return { needsSplit: true, type: 'single-event', events: [cleanEvent(whatTimeMatch[1] + ' ' + whatTimeMatch[2])] };
  }

  // "Which book/movie/event did I X a week/month ago"
  const whichAgoMatch = question.match(/which\s+(.+?)\s+did\s+I\s+(.+?)\s+(?:a\s+)?(?:week|month|day|last)\s*(?:ago)?/i);
  if (whichAgoMatch) {
    return { needsSplit: true, type: 'single-event', events: [cleanEvent(whichAgoMatch[1] + ' ' + whichAgoMatch[2])] };
  }

  return { needsSplit: false, type: null, events: [] };
}

/**
 * Split a list of events from ordering questions.
 * "trip to Miami, concert with Sarah, and museum visit"
 * → ["trip to Miami", "concert with Sarah", "museum visit"]
 */
function splitEventList(text) {
  // Split on ", and ", ", or ", commas, semicolons
  // But preserve "and" within event phrases by splitting on structural patterns
  return text
    .replace(/,\s*and\s+/gi, '|||')
    .replace(/,\s*or\s+/gi, '|||')
    .replace(/;\s*/g, '|||')
    .replace(/,\s+/g, '|||')
    .split('|||')
    .map(e => cleanEvent(e.trim()))
    .filter(e => e.length > 3);
}

/**
 * Clean an extracted event phrase.
 */
function cleanEvent(event) {
  return event
    .replace(/^(my|the|a|an|that|this)\s+/i, '')
    .replace(/\s+$/, '')
    .replace(/['"]/g, '')
    .trim();
}

export { splitEventList, cleanEvent };
