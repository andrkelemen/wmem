// drain.mjs — drain loop with exponential backoff + dead-letter.

export class Drain {
  constructor({ outbox, probe, upstreamUrl, opts = {}, logger = console }) {
    this.outbox = outbox;
    this.probe = probe;
    this.upstreamUrl = upstreamUrl;
    this.logger = logger;
    this.opts = {
      tickIntervalMs: opts.tickIntervalMs ?? 5000,
      batch: opts.batch ?? 25,
      deadLetterAfter: opts.deadLetterAfter ?? 12,
      backoffBaseS: opts.backoffBaseS ?? 30,
      timeoutMs: opts.timeoutMs ?? 3000,
      minInterRequestMs: opts.minInterRequestMs ?? 50,
    };
    this.last_drain_ts = null;
    this.last_drain_result = null;
    this._timer = null;
    this._running = false;
  }

  async tick() {
    if (this._running) return; // re-entry guard
    this._running = true;
    try {
      if (!this.probe.state.reachable) {
        this.last_drain_ts = Date.now();
        this.last_drain_result = 'upstream_unreachable';
        return;
      }
      // §5: warn-every-drain-tick if upstream role isn't master ()
      if (this.probe.state.role && this.probe.state.role !== 'master') {
        this.logger.warn(`[drain] upstream role is '${this.probe.state.role}', not 'master'. Draining anyway; isMaster gate will refuse via 403 → dead-letter.`);
      }

      const rows = this.outbox.eligibleForDrain({
        baseBackoffS: this.opts.backoffBaseS,
        batch: this.opts.batch,
      });
      if (rows.length === 0) {
        this.last_drain_ts = Date.now();
        this.last_drain_result = 'no_pending';
        return;
      }

      let drained = 0, dedup = 0, retried = 0, dead = 0, fourxx = 0;
      for (const row of rows) {
        if (this.opts.minInterRequestMs > 0) {
          await new Promise(r => setTimeout(r, this.opts.minInterRequestMs));
        }
        const result = await this._replay(row);
        switch (result.kind) {
          case 'success':
            this.outbox.deleteRow(row.id);
            drained++;
            this.logger.info(`[drain] success id=${row.id} ${row.method} ${row.endpoint}`);
            break;
          case 'dedup':
            this.outbox.deleteRow(row.id);
            dedup++;
            this.logger.info(`[drain] dedup-collision id=${row.id} ${row.endpoint}`);
            break;
          case 'four_xx':
            this.outbox.markDeadLetter(row.id, result.err);
            dead++;
            fourxx++;
            this.logger.error(`[drain] 4xx-dead id=${row.id} ${row.endpoint} → ${result.err}`);
            break;
          case 'retry':
            if (row.retry_count + 1 >= this.opts.deadLetterAfter) {
              this.outbox.markDeadLetter(row.id, result.err);
              dead++;
              this.logger.error(`[drain] exhausted id=${row.id} ${row.endpoint} after ${row.retry_count + 1} retries: ${result.err}`);
            } else {
              this.outbox.markRetry(row.id, result.err);
              retried++;
            }
            break;
        }
      }

      this.last_drain_ts = Date.now();
      this.last_drain_result = `drained=${drained} dedup=${dedup} retried=${retried} dead=${dead}`;
    } catch (err) {
      this.logger.error(`[drain] tick error: ${err.message}`);
      this.last_drain_result = `error: ${err.message}`;
    } finally {
      this._running = false;
    }
  }

  async _replay(row) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
      const headers = JSON.parse(row.headers_json || '{}');
      // strip transport-level headers that don't make sense to forward
      delete headers['host'];
      delete headers['Host'];
      delete headers['content-length'];
      delete headers['Content-Length'];
      delete headers['expect'];
      delete headers['Expect'];
      const res = await fetch(`${this.upstreamUrl}${row.endpoint}`, {
        method: row.method,
        headers,
        body: row.method === 'GET' || row.method === 'HEAD' ? undefined : row.payload,
        signal: ctrl.signal,
      });
      clearTimeout(t);

      // Read body to inspect for deduped flag
      const text = await res.text().catch(() => '');
      // dedup contract: upstream returns 200 with {deduped:true} OR 409. accept both.
      if (res.status === 409) return { kind: 'dedup' };
      if (res.status >= 200 && res.status < 300) {
        try {
          const body = JSON.parse(text);
          if (body && body.deduped === true) return { kind: 'dedup' };
        } catch { /* not json, that's fine */ }
        return { kind: 'success' };
      }
      if (res.status >= 400 && res.status < 500) {
        return { kind: 'four_xx', err: `${res.status} ${text.slice(0, 200)}` };
      }
      return { kind: 'retry', err: `${res.status} ${text.slice(0, 200)}` };
    } catch (err) {
      return { kind: 'retry', err: err.message };
    }
  }

  start() {
    this._timer = setInterval(() => this.tick(), this.opts.tickIntervalMs);
    // immediate first tick
    setTimeout(() => this.tick(), 100);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }

  snapshot() {
    return {
      last_drain_ts: this.last_drain_ts,
      last_drain_result: this.last_drain_result,
      opts: this.opts,
    };
  }
}
