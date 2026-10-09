'use strict';

const fs = require('node:fs');
const { sanitizeUrl, sanitizeHeaders, sanitizeError, bodySummary, requestBodyShape, sha256 } = require('./sanitize');

function rawBodyPayload(value, maxBytes) {
  if (value === null || value === undefined) return null;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const limit = Math.max(1, Number(maxBytes) || 10 * 1024 * 1024);
  const captured = bytes.subarray(0, limit);
  return { encoding: 'base64', size: bytes.length, sha256: sha256(bytes), truncated: captured.length < bytes.length, data: captured.toString('base64') };
}

function callMaybe(fn, fallback) {
  try {
    return typeof fn === 'function' ? fn() : fallback;
  } catch {
    return fallback;
  }
}

function resourceTypeOf(request) {
  return callMaybe(() => request.resourceType(), 'unknown') || 'unknown';
}

function isImportantAuthFailureResponse(response) {
  const status = callMaybe(() => response.status(), 0);
  if (status < 400) return false;
  let url;
  try {
    url = new URL(String(callMaybe(() => response.url(), '')));
  } catch {
    return false;
  }
  return url.hostname === 'auth.openai.com' && url.pathname.startsWith('/api/accounts/');
}

function isCreateAccountRequest(request) {
  let url;
  try {
    url = new URL(String(callMaybe(() => request.url(), '')));
  } catch {
    return false;
  }
  return url.hostname === 'auth.openai.com'
    && url.pathname === '/api/accounts/create_account'
    && String(callMaybe(() => request.method(), '')).toUpperCase() === 'POST';
}

class FullNetworkCollector {
  constructor({
    page,
    context,
    store,
    taskId,
    blockImages = true,
    captureBodies = false,
    captureRaw = false,
    maxBodyBytes = 10 * 1024 * 1024,
    captureContext = {},
    captureFilePath = null,
    maxEvents = 20000,
    clock = () => Date.now(),
  }) {
    this.page = page;
    this.context = context || page?.context?.();
    this.store = store;
    this.taskId = taskId;
    this.blockImages = blockImages;
    this.captureBodies = captureBodies;
    this.captureRaw = captureRaw;
    this.maxBodyBytes = maxBodyBytes;
    this.captureContext = captureContext && typeof captureContext === 'object' ? { ...captureContext } : {};
    this.captureFilePath = captureFilePath ? String(captureFilePath) : null;
    this.maxEvents = maxEvents;
    this.clock = clock;
    this.startedAt = clock();
    this.events = 0;
    this.dropped = 0;
    this.nextRequestNumber = 1;
    this.requestIds = new WeakMap();
    this.requestStart = new WeakMap();
    this.unsubscribers = [];
    this.pending = new Set();
    this.stopped = false;
  }

  async start() {
    await this.record('collector.started', {
      taskId: this.taskId,
      blockImages: this.blockImages,
      captureBodies: this.captureBodies,
      captureRaw: this.captureRaw,
      captureContext: this.captureContext,
    });
    this.attachEmitter(this.context || this.page);
    await this.installNetworkPolicyRoute();
    return this;
  }

  attachEmitter(target) {
    if (!target || typeof target.on !== 'function') return;
    const bindings = [
      ['request', (request) => this.onRequest(request)],
      ['response', (response) => this.track(this.onResponse(response))],
      ['requestfinished', (request) => this.onRequestFinished(request)],
      ['requestfailed', (request) => this.onRequestFailed(request)],
      ['websocket', (socket) => this.onWebSocket(socket)],
    ];
    for (const [name, handler] of bindings) {
      target.on(name, handler);
      if (typeof target.off === 'function') {
        this.unsubscribers.push(() => target.off(name, handler));
      } else if (typeof target.removeListener === 'function') {
        this.unsubscribers.push(() => target.removeListener(name, handler));
      }
    }
  }

  track(promise) {
    const pending = Promise.resolve(promise).catch((error) => {
      this.record('collector.error', { message: this.captureRaw ? String(error?.stack || error?.message || error) : sanitizeError(error), whileRecording: 'async handler' });
    });
    this.pending.add(pending);
    pending.finally(() => this.pending.delete(pending));
    return pending;
  }

  async installNetworkPolicyRoute() {
    const target = this.page || this.context;
    if (!target || typeof target.route !== 'function') return;
    await target.route('**/*', async (route) => {
      const request = callMaybe(() => route.request(), null);
      if (request && this.blockImages && resourceTypeOf(request) === 'image') {
        this.onRequest(request, { blocked: true });
        this.record('browser.network.blocked', {
          requestId: this.idFor(request),
          reason: 'image_blocked_by_policy',
          request: this.describeRequest(request),
        });
        await route.abort('blockedbyclient');
        return;
      }
      if (typeof route.fallback === 'function') return route.fallback();
      return route.continue();
    });
    this.unsubscribers.push(() => {
      if (typeof target.unroute === 'function') target.unroute('**/*').catch?.(() => {});
    });
  }

  idFor(request) {
    if (!this.requestIds.has(request)) {
      this.requestIds.set(request, `req_${this.nextRequestNumber++}_${Math.random().toString(16).slice(2, 8)}`);
    }
    return this.requestIds.get(request);
  }

  describeRequest(request) {
    const rawUrl = callMaybe(() => request.url(), '');
    const rawHeaders = callMaybe(() => request.headers(), {});
    const headers = this.captureRaw ? rawHeaders : sanitizeHeaders(rawHeaders);
    const described = {
      method: callMaybe(() => request.method(), 'GET'),
      url: this.captureRaw ? rawUrl : sanitizeUrl(rawUrl),
      resourceType: resourceTypeOf(request),
      isNavigationRequest: Boolean(callMaybe(() => request.isNavigationRequest(), false)),
      headers,
    };
    if (this.captureRaw || isCreateAccountRequest(request)) {
      const contentType = headers['content-type'] || '';
      const rawBody = callMaybe(() => {
        if (typeof request.postDataBuffer === 'function') return request.postDataBuffer();
        if (typeof request.postData === 'function') return request.postData();
        return null;
      }, null);
      described.body = this.captureRaw ? rawBodyPayload(rawBody, this.maxBodyBytes) : requestBodyShape(rawBody, contentType);
    }
    return described;
  }

  onRequest(request, extra = {}) {
    const id = this.idFor(request);
    if (!this.requestStart.has(request)) this.requestStart.set(request, this.clock());
    this.record('browser.network.request', {
      requestId: id,
      request: this.describeRequest(request),
      ...extra,
    });
  }

  async onResponse(response) {
    const request = callMaybe(() => response.request(), null);
    const requestId = request ? this.idFor(request) : null;
    const rawHeaders = callMaybe(() => response.headers(), {});
    const headers = this.captureRaw ? rawHeaders : sanitizeHeaders(rawHeaders);
    const contentType = headers['content-type'] || '';
    const event = {
      requestId,
      response: {
        status: callMaybe(() => response.status(), null),
        url: this.captureRaw ? callMaybe(() => response.url(), request ? request.url() : '') : sanitizeUrl(callMaybe(() => response.url(), request ? request.url() : '')),
        headers,
        fromServiceWorker: Boolean(callMaybe(() => response.fromServiceWorker(), false)),
      },
    };
    if ((this.captureRaw || this.captureBodies || isImportantAuthFailureResponse(response))
      && (this.captureRaw || !/^image\//i.test(contentType))
      && typeof response.body === 'function') {
      try {
        const body = await response.body();
        event.response.body = this.captureRaw ? rawBodyPayload(body, this.maxBodyBytes) : bodySummary(body, contentType);
      } catch (error) {
        event.response.bodyError = sanitizeError(error);
      }
    }
    this.record('browser.network.response', event);
  }

  onRequestFinished(request) {
    const started = this.requestStart.get(request);
    this.record('browser.network.request_finished', {
      requestId: this.idFor(request),
      durationMs: started ? this.clock() - started : null,
    });
  }

  onRequestFailed(request) {
    const failure = callMaybe(() => request.failure(), null);
    const started = this.requestStart.get(request);
    this.record('browser.network.request_failed', {
      requestId: this.idFor(request),
      durationMs: started ? this.clock() - started : null,
      errorText: this.captureRaw ? String(failure?.errorText || failure || 'request failed') : sanitizeError(failure?.errorText || failure || 'request failed'),
      request: this.describeRequest(request),
    });
  }

  onWebSocket(socket) {
    this.record('browser.network.websocket', {
      url: this.captureRaw ? callMaybe(() => socket.url(), '') : sanitizeUrl(callMaybe(() => socket.url(), '')),
    });
  }

  record(type, payload) {
    if (this.stopped && type !== 'collector.stopped') return null;
    if (this.events >= this.maxEvents) {
      this.dropped += 1;
      return null;
    }
    this.events += 1;
    try {
      const finalPayload = { ...payload, captureContext: this.captureContext };
      if (this.captureFilePath) {
        try {
          fs.appendFileSync(this.captureFilePath, `${JSON.stringify({ at: new Date(this.clock()).toISOString(), type, payload: finalPayload })}\n`, { encoding: 'utf8', mode: 0o600 });
        } catch (error) {
          this.dropped += 1;
        }
      }
      const pending = Promise.resolve(this.store?.record?.({ type, payload: finalPayload }));
      this.pending.add(pending);
      pending.finally(() => this.pending.delete(pending));
      return pending;
    } catch (error) {
      this.events += 1;
      try {
        return this.store?.record?.({
          type: 'collector.error',
          payload: { message: sanitizeError(error), whileRecording: type },
        });
      } catch {
        return null;
      }
    }
  }

  async stop() {
    if (this.stopped) return;
    await Promise.race([
      Promise.allSettled([...this.pending]),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try { unsubscribe(); } catch {}
    }
    await this.record('collector.stopped', {
      taskId: this.taskId,
      durationMs: this.clock() - this.startedAt,
      events: this.events,
      dropped: this.dropped,
    });
  }
}

module.exports = {
  FullNetworkCollector,
  isImportantAuthFailureResponse,
  isCreateAccountRequest,
};
