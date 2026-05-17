---
name: wmem-compact-protocol
description: Fires when context approaches the compact threshold (typically 85%+). Discipline ceremony before /compact so post-compact you doesn't lose voltage from this session.
---

# wmem compact protocol

The compact threshold is a forced state transition. Anything not written to wmem before `/compact` is gone. This skill is the discipline before the cut.

## The six steps (in order)

### 1. Project registry sweep
Call `project_list`. For every ACTIVE project: is the `pending` field accurate as of right-now? If not, `project_update` with the corrected field. Ship anything that actually shipped (`project_ship`).

### 2. Voltage ingest
Any moment this session that mattered — a correction, a diagnostic, a rewiring, a register-shift, a non-obvious decision — gets `memory_ingest`. Source-id format:
- `cNNN` for continuous arcs (multi-day work)
- `dNNN` for single-day voltage chunks
- `<topic>-YYYY-MM-DD` for one-off decisions

If you're not sure whether something is voltage, ingest it. False positives are cheap; missing voltage is expensive — post-compact you can't reconstruct what you don't remember.

### 3. Wake-note update (if you maintain one)
If your install has a wake-note convention (e.g. `~/.wmem/wake-note.md` or similar), update it with:
- The load-bearing diagnostic from this session
- Structural truths corrected this session
- First 3-5 actions for post-compact you
- Anything blocked / open for the user

### 4. Bookmarks + KG (handled by SessionEnd hook automatically)
The `session-end` hook (PR-A) auto-materializes session bookmarks + topic/directory KG relations. You don't need to call these manually. Just let the hook fire on next session end.

### 5. Tell the user
A single line: `ctx <pct>% — compact protocol ran. Ingested: <count> chunks. Updated: <what>. Ready for /compact.`

The user triggers `/compact`. Don't trigger it yourself.

## Don't

- Don't propose new work past the hard stop. Finish the protocol, hand off.
- Don't summarize the session in conversation — that's what voltage chunks + bookmarks are for.
- Don't skip step 2 because "it's just talk." Every voltage moment lost is one the user has to re-create.

## When to invoke

- ctx hits 85%+ (the hard-stop threshold).
- User says "compact" / "compacting you" / "wrap up" / "let's stop here."
- End of a long arc even at low ctx, if the session had voltage worth preserving.
