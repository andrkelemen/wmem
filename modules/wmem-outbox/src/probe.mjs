// probe.mjs — upstream reachability + role check, polled on interval.

export class UpstreamProbe {
  constructor({ url, timeoutMs = 2000, intervalMs = 10000, logger = console, onChange }) {
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.onChange = onChange ?? (() => {});
    this.state = { reachable: false, role: 'unknown', last_check_at: null, last_role_check_at: null };
    this._timer = null;
    this._roleTimer = null;
  }

  async checkReachable() {
    const prev = this.state.reachable;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const res = await fetch(`${this.url}/api/health`, { method: 'GET', signal: ctrl.signal });
      clearTimeout(t);
      this.state.reachable = res.ok;
    } catch {
      this.state.reachable = false;
    }
    this.state.last_check_at = Date.now();
    if (prev !== this.state.reachable) {
      this.logger.warn(`[probe] upstream reachable: ${prev} → ${this.state.reachable}`);
      this.onChange(this.state);
    }
    return this.state.reachable;
  }

  async checkRole() {
    const prev = this.state.role;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      const res = await fetch(`${this.url}/api/wmem/role`, { method: 'GET', signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const body = await res.json();
        this.state.role = body.role ?? 'unknown';
      } else {
        this.state.role = 'unknown';
      }
    } catch {
      this.state.role = 'unknown';
    }
    this.state.last_role_check_at = Date.now();
    if (prev !== this.state.role) {
      this.logger.warn(`[probe] upstream role: ${prev} → ${this.state.role}`);
      this.onChange(this.state);
    }
    return this.state.role;
  }

  start() {
    // probe immediately
    this.checkReachable();
    this.checkRole();
    this._timer = setInterval(() => this.checkReachable(), this.intervalMs);
    // role re-check every 60s (less frequent than reachability)
    this._roleTimer = setInterval(() => this.checkRole(), 60_000);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._roleTimer) clearInterval(this._roleTimer);
  }

  snapshot() { return { ...this.state }; }
}
