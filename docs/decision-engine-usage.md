# Decision Engine — Usage Guide

How to use `evaluate()` from `core/decision.mjs` to make personality-driven decisions about when an agent should speak, notify, or stay silent.

---

## Install / Import

```js
import { evaluate } from './core/decision.mjs';
```

No dependencies. No state. Pure function.

---

## Basic Call

```js
const result = evaluate(event, context);
```

Returns immediately. No async, no network, no model call.

---

## The Event Object

```js
{
  type: string,        // required — see supported types below
  timestamp: number,   // optional — ms since epoch, defaults to Date.now()
  // any additional fields are ignored by the engine
}
```

**Supported event types:**

| Type | Typical source |
|------|---------------|
| `session_start` | Claude Code `SessionStart` hook |
| `session_end` | Claude Code `SessionEnd` hook |
| `long_idle` | Heartbeat — user inactive > N minutes |
| `scheduled_check` | Cron / interval timer |
| `context_change` | Working directory or project changed |
| `error` | Tool call failed, process exited non-zero |
| `anomaly` | Unexpected pattern in observed data |
| `user_mentioned` | User referenced in another session |
| `task_completed` | Background task returned success |
| `task_failed` | Background task returned error |
| `memory_match` | Search found relevant past context |
| `drift_detected` | Capability or fact drift found by supervisor |
| `pattern_deviation` | Behavior differs from learned baseline |

Unknown types are treated as category `S1` (routine noise) with salience `0.3`.

---

## The Context Object

All fields are optional. Provide what you have; the engine degrades gracefully.

```js
{
  personality: object,        // personality row from DB (must include .decision block)
  lastInteraction: number,    // ms timestamp — last user message
  lastResponse: number,       // ms timestamp — last unprompted agent response
  unpromptedThisHour: number, // count of unprompted responses sent this hour
  sessionState: {
    focus: boolean,           // user is in active focus (blocks non-urgent events)
    activity: string,         // optional, not currently used by engine
  },
  patterns: object,           // reserved for future baseline comparison
}
```

---

## The Result Object

```js
{
  action: 'SILENCE' | 'NOTIFY' | 'SPEAK' | 'ACT',
  salience: number,           // 0.0–1.0 computed salience
  category: 'I1' | 'I2' | 'S1' | 'S2',
  channel: string,            // only when action === 'SPEAK'
  responseStyle: {            // only when action === 'SPEAK'
    maxWords: number,
    register: string,
    asksQuestions: boolean,
  },
  reason: string,             // human-readable — useful for logging
}
```

**Action meanings:**

| Action | What to do |
|--------|-----------|
| `SILENCE` | Do nothing |
| `NOTIFY` | Store to memory / log — don't push to user |
| `SPEAK` | Deliver a message via `channel` |
| `ACT` | Execute an action without speaking (reserved for future use) |

---

## Examples

### Minimal — no personality, no context

```js
import { evaluate } from './core/decision.mjs';

const result = evaluate({ type: 'error' });
// Uses DEFAULT_DECISION config
// result.action === 'SPEAK' (error weight 0.7 ≥ default threshold 0.5)
// result.category === 'I1'
```

### With personality

Load the active personality from the DB and pass it in:

```js
import { getActivePersonality } from './core/personality.mjs';
import { evaluate } from './core/decision.mjs';

const personality = getActivePersonality();

const result = evaluate(
  { type: 'memory_match', timestamp: Date.now() },
  { personality }
);

if (result.action === 'SPEAK') {
  // deliver to result.channel, respect result.responseStyle.maxWords
} else if (result.action === 'NOTIFY') {
  // log or store — don't push to user
}
// SILENCE — do nothing
```

### With full context

```js
const result = evaluate(
  { type: 'task_completed', timestamp: Date.now() },
  {
    personality,
    lastInteraction: Date.now() - 45 * 60 * 1000, // 45 min ago
    lastResponse:    Date.now() - 20 * 60 * 1000, // 20 min ago
    unpromptedThisHour: 1,
    sessionState: { focus: false },
  }
);
```

### Focus block

```js
const result = evaluate(
  { type: 'memory_match' },
  {
    personality: coderPersonality,   // neverInterruptFocus: true
    sessionState: { focus: true },
  }
);
// result.action === 'SILENCE'
// result.reason === 'focus policy — user is actively working'
```

I1 events (errors, anomalies, task failures) bypass the focus block:

```js
const result = evaluate(
  { type: 'error' },
  {
    personality: coderPersonality,
    sessionState: { focus: true },
  }
);
// result.action === 'SPEAK'  — errors get through regardless
```

### Using the reason field for logging

```js
const result = evaluate(event, context);
console.log(`[decision] ${event.type} → ${result.action} (salience=${result.salience.toFixed(2)}) — ${result.reason}`);
```

---

## Personality Decision Block

Each personality can override any field of the default decision config. Fields are shallow-merged — only the keys you set are overridden.

```json
{
  "decision": {
    "actionThreshold": 0.6,
    "cooldownMinutes": 15,
    "quietHours": [1, 7],
    "maxUnpromptedPerHour": 2,
    "salienceModifiers": {
      "error": 1.3,
      "task_failed": 1.5
    },
    "channelPreferences": ["chat"],
    "responseStyle": {
      "maxWords": 10,
      "register": "technical",
      "asksQuestions": false
    },
    "interruptionPolicy": {
      "neverInterruptFocus": true
    }
  }
}
```

**Fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `actionThreshold` | number | `0.5` | Minimum salience to SPEAK. Higher = quieter. |
| `cooldownMinutes` | number | `10` | Minimum minutes between unprompted responses. |
| `quietHours` | [start, end] | `[1, 7]` | Soft gate — suppresses SPEAK unless salience ≥ 0.9. Wrap-around supported: `[22, 6]`. |
| `maxUnpromptedPerHour` | number | `4` | Rate limit per hour. Suppresses SPEAK unless salience ≥ 0.9. |
| `salienceModifiers` | object | `{}` | Per-event multipliers. `{ "error": 1.3 }` boosts error salience by 30%. |
| `channelPreferences` | string[] | `['chat']` | First entry is used as the delivery channel for SPEAK. |
| `responseStyle.maxWords` | number | `12` | Soft guidance for response length. |
| `responseStyle.register` | string | `'neutral'` | Voice register hint: `technical`, `analytical`, `constructive`, etc. |
| `responseStyle.asksQuestions` | boolean | `false` | Whether this personality asks follow-up questions. |
| `interruptionPolicy.neverInterruptFocus` | boolean | `false` | Block all non-I1 events when `context.sessionState.focus` is true. |

---

## Built-in Personality Templates

Use `node scripts/personality.mjs create <name> --template <template>` to create a personality from a template.

### coder

High threshold, never interrupts focus, terse output. Speaks up for errors and failed tasks.

```
actionThreshold: 0.6  — quieter than default
cooldownMinutes: 15   — waits longer between responses
maxUnprompted/hr: 2   — minimal proactive output
neverInterruptFocus: true
salienceModifiers: { error: 1.3, task_failed: 1.5, task_completed: 1.2 }
responseStyle: { maxWords: 10, register: "technical", asksQuestions: false }
```

### architect

Medium threshold. Asks clarifying questions. Sensitive to drift and anomalies.

```
actionThreshold: 0.55
cooldownMinutes: 20
maxUnprompted/hr: 3
neverInterruptFocus: false
salienceModifiers: { drift_detected: 1.4, pattern_deviation: 1.3, anomaly: 1.2 }
responseStyle: { maxWords: 15, register: "analytical", asksQuestions: true }
```

### reviewer

Lower threshold. Constructive. Notices errors and drift. Most active after the default.

```
actionThreshold: 0.5  — same as default
cooldownMinutes: 10
maxUnprompted/hr: 4
neverInterruptFocus: false
salienceModifiers: { error: 1.5, drift_detected: 1.3 }
responseStyle: { maxWords: 20, register: "constructive", asksQuestions: false }
```

### writer

Highest threshold of all templates. Rarely speaks unprompted. Long cooldown.

```
actionThreshold: 0.65 — highest threshold
cooldownMinutes: 30   — longest cooldown
quietHours: [0, 8]    — extended quiet window
maxUnprompted/hr: 1   — lowest rate
neverInterruptFocus: true
salienceModifiers: { task_completed: 1.3 }
responseStyle: { maxWords: 8, register: "concise", asksQuestions: false }
```

### researcher

Lowest threshold. Most proactive. Shares relevant findings and memories.

```
actionThreshold: 0.45 — lowest threshold
cooldownMinutes: 10
maxUnprompted/hr: 5   — highest rate
neverInterruptFocus: false
salienceModifiers: { memory_match: 1.5, user_mentioned: 1.3, context_change: 1.2 }
responseStyle: { maxWords: 25, register: "informative", asksQuestions: true }
```

---

## Same Event, Different Personalities

This is the point. The `memory_match` event with a 45-minute idle:

| Personality | salience | action | reason |
|-------------|---------|--------|--------|
| coder | 0.42 | SILENCE | salience 0.42 < threshold 0.60 |
| architect | 0.28 | NOTIFY | I2 below threshold — logged, not pushed |
| reviewer | 0.28 | NOTIFY | I2 below threshold — logged, not pushed |
| writer | 0.42 | SILENCE | salience 0.42 < threshold 0.65 |
| researcher | 0.42 | SPEAK | salience 0.42 ≥ threshold 0.45 |

*(Salience varies because salienceModifiers differ per personality. The researcher boosts `memory_match` by 1.5×.)*

---

## Integrating with the Supervisor / Heartbeat

A typical integration pattern for a background supervisor:

```js
import { evaluate } from './core/decision.mjs';
import { getActivePersonality } from './core/personality.mjs';

// Track state externally — the engine itself is stateless
let lastResponse = null;
let unpromptedThisHour = 0;
let hourBucket = new Date().getHours();

function onEvent(event, sessionState) {
  // Reset hourly counter when hour changes
  const currentHour = new Date().getHours();
  if (currentHour !== hourBucket) {
    unpromptedThisHour = 0;
    hourBucket = currentHour;
  }

  const personality = getActivePersonality();

  const result = evaluate(event, {
    personality,
    lastInteraction: getLastInteractionTime(), // from your session tracker
    lastResponse,
    unpromptedThisHour,
    sessionState,
  });

  if (result.action === 'SPEAK') {
    deliver(result.channel, generateResponse(event, result.responseStyle));
    lastResponse = Date.now();
    unpromptedThisHour++;
  } else if (result.action === 'NOTIFY') {
    storeToMemory(event, result);
  }
  // SILENCE — do nothing
}
```

---

## Exported Symbols

```js
import {
  evaluate,          // main function
  EVENT_WEIGHTS,     // base weight map
  EVENT_CATEGORY,    // category map
  DEFAULT_DECISION,  // default config object
} from './core/decision.mjs';
```

`EVENT_WEIGHTS`, `EVENT_CATEGORY`, and `DEFAULT_DECISION` are exported for testing and introspection. They are not meant to be mutated at runtime.
