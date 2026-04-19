/*
  core/session-identity.mjs — per-MCP-process caller state.

  State lifecycle:
    WMEM_CALLER   — env anchor, immutable, set once at process startup.
    _currentCaller — runtime-mutable, initialized to WMEM_CALLER.

  Policy (handler layer owns, not this module):
    - agent_switch mutates _currentCaller. Admin-gate + target-validate at
      the handler, not here. This module is the raw mutator; the handler
      is the policy point.
    - resolveCaller enforces the args.agent admin gate. Single point of
      change covers all handlers that route through it (capability_*,
      mail_*, any future handler).

  Scope:
    MCP stdio session only. HTTP path uses req.caller (X-Caller header)
    — independent state, unaffected by this module.

  Testability:
    isAdmin() reads env lazily (not a const) so tests can toggle
    WMEM_ADMIN between stages without module reload. __resetForTests
    restores _currentCaller to WMEM_CALLER — not exported for production
    use.
*/

export const WMEM_CALLER = process.env.WMEM_CALLER || null;

let _currentCaller = WMEM_CALLER;

/**
 * Admin-mode check. Reads process.env.WMEM_ADMIN lazily per-call, not
 * cached at startup. Any process-env mutation takes effect immediately —
 * currently no tool mutates WMEM_ADMIN at runtime, but any future surface
 * that does (e.g. an admin-elevation MCP tool) should be aware that the
 * flip is observable by the next resolveCaller / handleAgentSwitch call
 * without restart. Lazy-read also enables test stages to toggle admin
 * mode between assertions.
 */
export function isAdmin() {
  return process.env.WMEM_ADMIN === '1';
}

export function getCurrentCaller() {
  return _currentCaller;
}

export function getEnvAnchor() {
  return WMEM_CALLER;
}

/**
 * Mutate the runtime caller. Admin-gating + target validation happen at
 * the handler layer. Returns the previous value.
 */
export function setCurrentCaller(id) {
  const prev = _currentCaller;
  _currentCaller = id;
  return prev;
}

/**
 * Handler entry point. Resolves the caller for a given tool invocation.
 * Admin-gates args.agent override. Throws on missing identity.
 *
 * Handler discipline: call ONCE at handler entry, bind to a local
 * (`const agent = resolveCaller(args)`). Do NOT re-resolve mid-handler
 * — _currentCaller could theoretically mutate between calls in admin
 * sessions with concurrent requests.
 */
export function resolveCaller(args) {
  if (args?.agent && !isAdmin()) {
    throw new Error(
      `agent override requires WMEM_ADMIN=1 in MCP env. ` +
      `Non-admin caller '${_currentCaller ?? 'unset'}' cannot stamp as '${args.agent}'.`,
    );
  }
  const caller = args?.agent || _currentCaller;
  if (!caller) {
    throw new Error(
      'agent_id required. Set WMEM_CALLER env var in .mcp.json, call agent_switch (admin), or pass `agent` explicitly (requires WMEM_ADMIN).',
    );
  }
  return caller;
}

/**
 * Test-only: reset _currentCaller to env anchor. Underscore prefix marks
 * this as non-production. Tests call it between stages to simulate
 * process restart.
 */
export function __resetForTests() {
  _currentCaller = WMEM_CALLER;
}
