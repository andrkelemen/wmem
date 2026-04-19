# Decision Engine — Technical Reference

`core/decision.mjs`

## Overview

The decision engine answers one question: *should the agent say something right now?*

The answer is not asked to an LLM. Asking an LLM whether to speak makes the model the judge of its own output — the decision and the output get coupled. A deterministic state machine with explicit thresholds decouples them cleanly, is auditable, and has no per-decision cost.

**Architecture:** sensors → salience score → threshold check → output mode

```
event + context
      │
      ▼
  Hard overrides (focus policy)
      │
      ▼
  Salience computation
    base weight × personality modifier × context modifier
      │
      ▼
  Threshold checks
    threshold → below? → NOTIFY/SILENCE
    cooldown  → active? → NOTIFY
    rate limit→ hit?   → NOTIFY
    quiet hrs → active? → SILENCE
      │
      ▼
  Channel selection
      │
      ▼
  SILENCE | NOTIFY | SPEAK | ACT
```

---

## Event Base Weights

Every known event type has a base salience weight (0–1). Unknown event types default to `0.3`.

| Event | Weight | Notes |
|-------|--------|-------|
| `session_start` | 0.3 | Low — routine |
| `session_end` | 0.2 | Very low — just log it |
| `long_idle` | 0.5 | Medium — worth noticing |
| `scheduled_check` | 0.4 | Heartbeat / cron |
| `context_change` | 0.5 | Environment shifted |
| `error` | 0.7 | High — something failed |
| `anomaly` | 0.8 | High — unexpected pattern |
| `user_mentioned` | 0.6 | Medium-high |
| `task_completed` | 0.5 | Medium |
| `task_failed` | 0.7 | High — async task errored |
| `memory_match` | 0.4 | Low-medium |
| `drift_detected` | 0.6 | Medium-high |
| `pattern_deviation` | 0.6 | Medium-high |

Events with base weight ≥ 0.7 are classified as **urgent**. Urgent events bypass time-of-day dampening during context modifier computation.

---

## Event Categories

Event taxonomy:

| Category | Meaning | Default action |
|----------|---------|----------------|
| **I1** | Explicitly requires a response | SPEAK if above threshold |
| **I2** | Contextually suggests a response | NOTIFY if below threshold |
| **S1** | Irrelevant / routine noise | SILENCE if below threshold |
| **S2** | Noted for record — don't push | NOTIFY if below threshold |

| Event | Category |
|-------|----------|
| `error` | I1 |
| `anomaly` | I1 |
| `task_failed` | I1 |
| `session_start` | I2 |
| `long_idle` | I2 |
| `context_change` | I2 |
| `user_mentioned` | I2 |
| `drift_detected` | I2 |
| `pattern_deviation` | I2 |
| `session_end` | S1 |
| `scheduled_check` | S2 |
| `task_completed` | S2 |
| `memory_match` | S2 |

Unknown event types default to `S1`.

---

## Salience Computation

```
salience = base_weight × personality_modifier × context_modifier
salience = clamp(salience, 0.0, 1.0)
```

### 1. Base weight

The intrinsic importance of the event type. See Event Base Weights table above.

### 2. Personality modifier

Sourced from `personality.decision.salienceModifiers[event.type]`. Defaults to `1.0` if not set.

Example — `researcher` personality boosts `memory_match` by 1.5×:
```json
"salienceModifiers": { "memory_match": 1.5, "user_mentioned": 1.3 }
```

This means the same `memory_match` event produces a salience of `0.4 × 1.5 = 0.6` for the researcher, versus `0.4` for a personality without the modifier.

### 3. Context modifier

Two factors:

**Time since last interaction** (`context.lastInteraction`):

| Time since last message | Multiplier |
|------------------------|-----------|
| < 5 min | 0.3 — just talked, back off |
| 5–30 min | 0.7 — cooling off |
| 30 min – 2 hr | 1.0 — normal |
| 2–6 hr | 1.3 — been a while |
| > 6 hr | 1.5 — long absence |

**Time of day** (skipped for urgent events):

| Hour | Multiplier |
|------|-----------|
| 01:00–06:00 | 0.3 — late night |
| 06:00–12:00 | 0.8 — morning |
| 12:00–17:00 | 1.0 — peak |
| 17:00–21:00 | 1.1 — evening |
| 21:00–01:00 | 0.9 — winding down |

---

## Decision Pipeline

### Hard override: focus policy

Checked before salience is computed. If the personality has `interruptionPolicy.neverInterruptFocus = true` and `context.sessionState.focus` is truthy, and the event category is not `I1`:

```
→ SILENCE (reason: "focus policy — user is actively working")
```

I1 events (errors, anomalies, task failures) bypass the focus block.

### Threshold check

If `salience < decision.actionThreshold`:
- Category `S2` or `I2` → `NOTIFY` (logged, searchable, not pushed to user)
- Category `S1` or `I1` → `SILENCE`

### Cooldown check

If a response was sent within `decision.cooldownMinutes` and `salience < 0.9`:

```
→ NOTIFY (reason: "cooldown: Xmin < Ymin")
```

Salience ≥ 0.9 overrides cooldown — urgent events always get through.

### Rate limit check

If `context.unpromptedThisHour >= decision.maxUnpromptedPerHour` and `salience < 0.9`:

```
→ NOTIFY (reason: "rate limit: X/Y/hr")
```

### Quiet hours check (soft gate)

`decision.quietHours` is `[startHour, endHour]`. The gate is soft — if `salience ≥ 0.9`, the event goes through anyway.

Supports wrap-around: `[22, 6]` means 22:00 to 06:00.

If the current hour is in the quiet window and `salience < 0.9`:

```
→ SILENCE (reason: "quiet hours (start-end)")
```

### Channel selection and SPEAK

If none of the above gates fire:

```
channel = decision.channelPreferences[0] || 'chat'
→ SPEAK { channel, responseStyle, salience, category, reason }
```

---

## Default Decision Config

Applied as a base, then merged with `personality.decision` overrides (shallow merge).

```js
{
  actionThreshold: 0.5,
  cooldownMinutes: 10,
  quietHours: [1, 7],
  maxUnpromptedPerHour: 4,
  salienceModifiers: {},
  channelPreferences: ['chat'],
  responseStyle: {
    maxWords: 12,
    register: 'neutral',
    asksQuestions: false,
  },
  interruptionPolicy: {
    neverInterruptFocus: false,
  },
}
```

---

## Output Object

```ts
{
  action: 'SILENCE' | 'NOTIFY' | 'SPEAK' | 'ACT',
  salience: number,          // 0.0–1.0
  category: 'I1' | 'I2' | 'S1' | 'S2',
  channel?: string,          // present when action === 'SPEAK'
  responseStyle?: {          // present when action === 'SPEAK'
    maxWords: number,
    register: string,
    asksQuestions: boolean,
  },
  reason: string,            // human-readable explanation
}
```

Action meanings:

| Action | Meaning |
|--------|---------|
| `SILENCE` | Do nothing |
| `NOTIFY` | Log for later reference — don't push to user |
| `SPEAK` | Deliver message via preferred channel |
| `ACT` | Execute action without speaking (reserved) |

---

## Design Rationale

**Why not an LLM?** Silence decisions are binary classifiers. Asking the model to make them couples the decision to the output — the thing producing the answer is also judging whether it should have answered. A state machine with explicit thresholds decouples them cleanly, is auditable, and has zero inference cost.

**Why NOTIFY?** The gap in most systems: something happened that's worth remembering but not worth saying right now. NOTIFY fills this — logged, searchable, not pushed. The user can query for it later; the agent doesn't spam.

**Why soft quiet hours?** Absolute quiet hours mean errors go unreported at 3am. Salience ≥ 0.9 means the event is genuinely urgent and the user should know. The gate is a filter, not a wall.

**Why per-personality thresholds?** The same `memory_match` event shouldn't trigger the coder (focus, terse, high threshold) the same way it triggers the researcher (proactive, informative, low threshold). Personality is not just voice — it determines when to speak.
