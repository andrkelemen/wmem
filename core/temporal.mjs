/**
 * temporal.mjs — Date resolver for temporal queries
 *
 * Parses natural language time expressions and converts to timestamp ranges.
 * No LLM. Regex + date math.
 *
 * "last tuesday" → [2026-04-07T00:00, 2026-04-08T00:00]
 * "yesterday" → [2026-04-13T00:00, 2026-04-14T00:00]
 * "last week" → [2026-04-06T00:00, 2026-04-13T00:00]
 * "in march" → [2026-03-01T00:00, 2026-04-01T00:00]
 *
 * Used as a pre-filter: narrow chunks by time BEFORE search.
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * Detect if a query has a temporal expression.
 * Returns { hasTemporal, expression, type }
 */
export function detectTemporal(query) {
  const q = query.toLowerCase();

  // "last tuesday", "last monday", etc.
  const lastDay = q.match(/last\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (lastDay) return { hasTemporal: true, expression: lastDay[0], type: 'last_day', value: lastDay[1] };

  // "yesterday"
  if (/\byesterday\b/.test(q)) return { hasTemporal: true, expression: 'yesterday', type: 'yesterday' };

  // "today"
  if (/\btoday\b/.test(q)) return { hasTemporal: true, expression: 'today', type: 'today' };

  // "last week"
  if (/\blast\s+week\b/.test(q)) return { hasTemporal: true, expression: 'last week', type: 'last_week' };

  // "this week"
  if (/\bthis\s+week\b/.test(q)) return { hasTemporal: true, expression: 'this week', type: 'this_week' };

  // "last month"
  if (/\blast\s+month\b/.test(q)) return { hasTemporal: true, expression: 'last month', type: 'last_month' };

  // "this month"
  if (/\bthis\s+month\b/.test(q)) return { hasTemporal: true, expression: 'this month', type: 'this_month' };

  // "N days ago"
  const daysAgo = q.match(/(\d+)\s+days?\s+ago/);
  if (daysAgo) return { hasTemporal: true, expression: daysAgo[0], type: 'days_ago', value: parseInt(daysAgo[1]) };

  // "N weeks ago"
  const weeksAgo = q.match(/(\d+)\s+weeks?\s+ago/);
  if (weeksAgo) return { hasTemporal: true, expression: weeksAgo[0], type: 'weeks_ago', value: parseInt(weeksAgo[1]) };

  // "N months ago"
  const monthsAgo = q.match(/(\d+)\s+months?\s+ago/);
  if (monthsAgo) return { hasTemporal: true, expression: monthsAgo[0], type: 'months_ago', value: parseInt(monthsAgo[1]) };

  // "in january", "in march", etc.
  const inMonth = q.match(/\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
  if (inMonth) return { hasTemporal: true, expression: inMonth[0], type: 'in_month', value: inMonth[1] };

  // "since [day/date]"
  const since = q.match(/\bsince\s+(last\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (since) return { hasTemporal: true, expression: since[0], type: 'since_day', value: since[2] };

  // "how long", "how many days/weeks/months"
  if (/\bhow\s+(long|many\s+(days|weeks|months))\b/.test(q)) return { hasTemporal: true, expression: 'duration query', type: 'duration' };

  // "first time", "when did I first"
  if (/\bfirst\s+time\b|\bwhen\s+did\s+\w+\s+first\b/.test(q)) return { hasTemporal: true, expression: 'first occurrence', type: 'first' };

  // "recently", "lately"
  if (/\brecently\b|\blately\b/.test(q)) return { hasTemporal: true, expression: 'recent', type: 'recent' };

  // "previous", "before"
  if (/\bprevious\b|\bbefore\s+\w+\s+(changed|switched|moved|started|stopped)\b/.test(q)) return { hasTemporal: true, expression: 'previous state', type: 'previous' };

  return { hasTemporal: false };
}

/**
 * Resolve a temporal expression to a timestamp range [start, end].
 *
 * @param {object} temporal — from detectTemporal()
 * @param {number} now — reference timestamp (default: Date.now())
 * @returns {{ start: number, end: number } | null}
 */
export function resolveTimeRange(temporal, now = Date.now()) {
  if (!temporal.hasTemporal) return null;

  const d = new Date(now);
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const endOfDay = (date) => startOfDay(date) + 86400000;
  const MS_DAY = 86400000;

  switch (temporal.type) {
    case 'yesterday':
      return { start: startOfDay(d) - MS_DAY, end: startOfDay(d) };

    case 'today':
      return { start: startOfDay(d), end: endOfDay(d) };

    case 'last_day': {
      const targetDay = DAY_NAMES.indexOf(temporal.value);
      const currentDay = d.getDay();
      let diff = currentDay - targetDay;
      if (diff <= 0) diff += 7;
      const target = new Date(now - diff * MS_DAY);
      return { start: startOfDay(target), end: endOfDay(target) };
    }

    case 'last_week':
      return { start: now - 14 * MS_DAY, end: now - 7 * MS_DAY };

    case 'this_week': {
      const dayOfWeek = d.getDay();
      const weekStart = startOfDay(d) - dayOfWeek * MS_DAY;
      return { start: weekStart, end: now };
    }

    case 'last_month': {
      const lastMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const thisMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      return { start: lastMonth.getTime(), end: thisMonth.getTime() };
    }

    case 'this_month':
      return { start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), end: now };

    case 'days_ago':
      return { start: now - (temporal.value + 1) * MS_DAY, end: now - (temporal.value - 1) * MS_DAY };

    case 'weeks_ago':
      return { start: now - (temporal.value + 1) * 7 * MS_DAY, end: now - (temporal.value - 1) * 7 * MS_DAY };

    case 'months_ago': {
      const start = new Date(d.getFullYear(), d.getMonth() - temporal.value - 1, 1);
      const end = new Date(d.getFullYear(), d.getMonth() - temporal.value + 1, 1);
      return { start: start.getTime(), end: end.getTime() };
    }

    case 'in_month': {
      const monthIdx = MONTH_NAMES.indexOf(temporal.value);
      const year = monthIdx > d.getMonth() ? d.getFullYear() - 1 : d.getFullYear();
      return { start: new Date(year, monthIdx, 1).getTime(), end: new Date(year, monthIdx + 1, 1).getTime() };
    }

    case 'since_day': {
      const targetDay = DAY_NAMES.indexOf(temporal.value);
      const currentDay = d.getDay();
      let diff = currentDay - targetDay;
      if (diff <= 0) diff += 7;
      return { start: now - diff * MS_DAY, end: now };
    }

    case 'recent':
      return { start: now - 7 * MS_DAY, end: now };

    case 'previous':
      return { start: now - 90 * MS_DAY, end: now }; // wide window for "previous" state

    case 'duration':
    case 'first':
      return null; // can't narrow by time, needs full search

    default:
      return null;
  }
}

export { DAY_NAMES, MONTH_NAMES };
