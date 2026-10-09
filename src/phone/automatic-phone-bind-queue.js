'use strict';

class AutomaticPhoneBindQueue {
  constructor({ getConcurrency, run, onChange = null, onError, now = () => Date.now() }) {
    this.getConcurrency = getConcurrency;
    this.run = run;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    if (typeof onError !== 'function') {
      throw new TypeError('AutomaticPhoneBindQueue requires an onError callback');
    }
    this.onError = onError;
    this.now = now;
    this.pending = new Map();
    this.active = new Set();
    this.timer = null;
    this.sequence = 0;
    this.changeSnapshot = null;
    this.changeTask = null;
  }

  enqueue(email, { force = false, notBefore = 0 } = {}) {
    const key = String(email || '').trim().toLowerCase();
    if (!key || this.active.has(key)) return false;
    const existing = this.pending.get(key);
    const entry = {
      email: key,
      force: Boolean(force || existing?.force),
      notBefore: force ? 0 : Math.max(0, Number(notBefore || existing?.notBefore || 0)),
      sequence: existing?.sequence ?? this.sequence++,
    };
    this.pending.set(key, entry);
    this.#changed();
    this.drain();
    return true;
  }

  remove(email) {
    const removed = this.pending.delete(String(email || '').trim().toLowerCase());
    if (removed) this.#changed();
    return removed;
  }

  position(email) {
    return this.#ordered().findIndex((entry) => entry.email === String(email || '').trim().toLowerCase()) + 1;
  }

  snapshot() {
    return {
      active: [...this.active],
      pending: this.#ordered().map((entry) => ({ ...entry })),
      concurrency: this.#concurrency(),
    };
  }

  drain() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const limit = this.#concurrency();
    const now = this.now();
    const ready = this.#ordered().filter((entry) => entry.force || entry.notBefore <= now);
    while (this.active.size < limit && ready.length) {
      const entry = ready.shift();
      if (!this.pending.delete(entry.email) || this.active.has(entry.email)) continue;
      this.active.add(entry.email);
      this.#changed();
      Promise.resolve()
        .then(() => this.run(entry.email, entry))
        .catch((error) => this.#reportError(error, { operation: 'run', email: entry.email }))
        .finally(() => {
          this.active.delete(entry.email);
          this.#changed();
          this.drain();
        });
    }
    const next = this.#ordered().find((entry) => !entry.force && entry.notBefore > now);
    if (!ready.length && next && this.active.size < limit) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, Math.max(1, next.notBefore - now));
      this.timer.unref?.();
    }
  }

  #ordered() {
    return [...this.pending.values()].sort((left, right) => (
      Number(right.force) - Number(left.force)
      || left.notBefore - right.notBefore
      || left.sequence - right.sequence
    ));
  }

  #concurrency() {
    const value = Number(this.getConcurrency?.());
    return Math.max(0, Math.min(30, Math.trunc(Number.isFinite(value) ? value : 0)));
  }

  #changed() {
    if (!this.onChange) return;
    this.changeSnapshot = this.snapshot();
    if (this.changeTask) return;
    this.changeTask = Promise.resolve().then(async () => {
      while (this.changeSnapshot) {
        const snapshot = this.changeSnapshot;
        this.changeSnapshot = null;
        try {
          await this.onChange(snapshot);
        } catch (error) {
          await this.#reportError(error, { operation: 'onChange' });
        }
      }
    }).finally(() => {
      this.changeTask = null;
      if (this.changeSnapshot) this.#changed();
    });
  }

  async #reportError(error, context) {
    try {
      await this.onError(error, context);
    } catch (reportingError) {
      console.error('automatic phone bind queue error reporting failed', reportingError);
    }
  }
}

module.exports = { AutomaticPhoneBindQueue };
