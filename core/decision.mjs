/**
 * decision.mjs — Proactive personality decision engine for wmem
 *
 * Determines when an agent should speak, notify, or stay silent.
 * Pure function: evaluate(event, context) → decision.
 * No side effects. No state. Fully testable.
 *
 * Why deterministic instead of LLM-based: models are unreliable at silence/speak decisions, and the decision IS the product. A state machine moves the threshold logic into an auditable surface.
 *
 * Architecture: sensors → salience score → threshold check → output mode
 * Same pattern as every state machine: inputs → thresholds → actions.
 */

// ── Event Base Weights ──────────────────────────────────
// Intrinsic importance of each event type (0-1).
// Override per-personality via decision.salienceModifiers.

const EVENT_WEIGHTS = {
  // Proactive triggers (generic, any agent)
  session_start:     0.3,
  session_end:       0.2,
  long_idle:         0.5,  // no interaction for extended period
  scheduled_check:   0.4,  // heartbeat / cron
  context_change:    0.5,  // environment shifted
  error:             0.7,  // something failed
  anomaly:           0.8,  // unexpected pattern
  user_mentioned:    0.6,  // referenced in another session/channel
  task_completed:    0.5,  // async task finished
  task_failed:       0.7,  // async task errored
  memory_match:      0.4,  // search found relevant past context
  drift_detected:    0.6,  // capability or fact drift
  pattern_deviation: 0.6,  // behavior differs from learned baseline
};

// ── Event Categories ─────────────────
// I1: explicitly requires response
// I2: contextually suggests response
// S1: irrelevant / routine
// S2: noted, logged, no action needed — NOTIFY candidate

const EVENT_CATEGORY = {
  session_start:     'I2',
  session_end:       'S1',
  long_idle:         'I2',
  scheduled_check:   'S2',
  context_change:    'I2',
  error:             'I1',
  anomaly:           'I1',
  user_mentioned:    'I2',
  task_completed:    'S2',
  task_failed:       'I1',
  memory_match:      'S2',
  drift_detected:    'I2',
  pattern_deviation: 'I2',
};

// ── Default Decision Config ─────────────────────────────
// Merged with personality.decision overrides.

const DEFAULT_DECISION = {
  actionThreshold: 0.5,
  cooldownMinutes: 10,
  quietHours: [1, 7],       // soft gate — salience > 0.9 overrides
  maxUnpromptedPerHour: 4,
  salienceModifiers: {},     // per-event multipliers
  channelPreferences: ['chat'],
  responseStyle: {
    maxWords: 12,
    register: 'neutral',
    asksQuestions: false,
  },
  interruptionPolicy: {
    neverInterruptFocus: false,  // don't interrupt during active work
  },
};

// ── Main Evaluation ─────────────────────────────────────

/**
 * Evaluate whether to act or stay silent.
 *
 * @param {object} event - { type, timestamp, ...data }
 * @param {object} context
 * @param {object} context.personality - personality with decision block
 * @param {number} context.lastInteraction - timestamp of last user message
 * @param {number} context.lastResponse - timestamp of last unprompted response
 * @param {number} context.unpromptedThisHour - count this hour
 * @param {object} context.sessionState - { activity, focus } (optional)
 * @param {object} context.patterns - learned baselines (optional)
 * @returns {{ action, salience, category, channel?, responseStyle?, reason }}
 *
 * Actions:
 *   SILENCE — do nothing (default, most common)
 *   NOTIFY  — log for later reference, don't push to user
 *   SPEAK   — deliver via preferred channel
 *   ACT     — execute an action without speaking
 */
export function evaluate(event, context = {}) {
  const decision = {
    ...DEFAULT_DECISION,
    ...context.personality?.decision,
  };
  const now = event.timestamp || Date.now();
  const category = EVENT_CATEGORY[event.type] || 'S1';

  // ── Hard overrides ────────────────────────────────

  // Focus policy — don't interrupt active work
  if (decision.interruptionPolicy?.neverInterruptFocus
      && context.sessionState?.focus
      && category !== 'I1') {
    return { action: 'SILENCE', salience: 0, category, reason: 'focus policy — user is actively working' };
  }

  // ── Compute salience ──────────────────────────────

  // 1. Base weight
  let salience = EVENT_WEIGHTS[event.type] || 0.3;

  // 2. Personality modifier
  const personalityMod = decision.salienceModifiers?.[event.type] ?? 1.0;
  salience *= personalityMod;

  // 3. Context modifiers
  const isUrgent = (EVENT_WEIGHTS[event.type] || 0) >= 0.7;
  salience *= computeContextModifier(context, now, isUrgent);

  // Clamp
  salience = Math.min(1.0, Math.max(0.0, salience));

  // ── Threshold checks ──────────────────────────────

  // Below threshold
  if (salience < decision.actionThreshold) {
    // S2/I2 below threshold → NOTIFY (logged, searchable, not pushed)
    if (category === 'S2' || category === 'I2') {
      return { action: 'NOTIFY', salience, category, reason: `${category} below threshold — logged, not pushed` };
    }
    return { action: 'SILENCE', salience, category, reason: `salience ${salience.toFixed(2)} < threshold ${decision.actionThreshold}` };
  }

  // Cooldown
  const minsSinceResponse = context.lastResponse ? (now - context.lastResponse) / 60000 : Infinity;
  if (minsSinceResponse < decision.cooldownMinutes && salience < 0.9) {
    return { action: 'NOTIFY', salience, category, reason: `cooldown: ${minsSinceResponse.toFixed(0)}min < ${decision.cooldownMinutes}min` };
  }

  // Rate limit
  if ((context.unpromptedThisHour || 0) >= decision.maxUnpromptedPerHour && salience < 0.9) {
    return { action: 'NOTIFY', salience, category, reason: `rate limit: ${context.unpromptedThisHour}/${decision.maxUnpromptedPerHour}/hr` };
  }

  // Quiet hours (soft gate — urgent overrides)
  const hour = new Date(now).getHours();
  const [qStart, qEnd] = decision.quietHours || [1, 7];
  const isQuiet = qStart < qEnd ? (hour >= qStart && hour < qEnd) : (hour >= qStart || hour < qEnd);
  if (isQuiet && salience < 0.9) {
    return { action: 'SILENCE', salience, category, reason: `quiet hours (${qStart}-${qEnd})` };
  }

  // ── Choose channel ────────────────────────────────

  const channel = decision.channelPreferences?.[0] || 'chat';

  return {
    action: 'SPEAK',
    salience,
    category,
    channel,
    responseStyle: decision.responseStyle || DEFAULT_DECISION.responseStyle,
    reason: `salience ${salience.toFixed(2)} ≥ ${decision.actionThreshold}, category=${category}, channel=${channel}`,
  };
}

// ── Context Modifier ────────────────────────────────────

function computeContextModifier(context, now, isUrgent) {
  let mod = 1.0;

  // Time since last interaction
  if (context.lastInteraction) {
    const mins = (now - context.lastInteraction) / 60000;
    if (mins < 5)       mod *= 0.3;   // just talked
    else if (mins < 30) mod *= 0.7;   // cooling off
    else if (mins < 120) mod *= 1.0;  // normal
    else if (mins < 360) mod *= 1.3;  // been a while
    else                  mod *= 1.5;  // long absence
  }

  // Time of day (urgent events bypass)
  if (!isUrgent) {
    const hour = new Date(now).getHours();
    if (hour >= 1 && hour < 6)       mod *= 0.3;
    else if (hour >= 6 && hour < 12)  mod *= 0.8;
    else if (hour >= 12 && hour < 17) mod *= 1.0;
    else if (hour >= 17 && hour < 21) mod *= 1.1;
    else                               mod *= 0.9;
  }

  return mod;
}

// ── Exports ─────────────────────────────────────────────

export { EVENT_WEIGHTS, EVENT_CATEGORY, DEFAULT_DECISION };
