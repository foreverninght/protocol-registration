'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { ProxyAgent } = require('undici');

const { createFingerprintBrowserSession } = require('../browser/lifecycle/fingerprint-browser');
const { PUBLIC_REFINING_BASE_URL, GC_TACMON_BASE_URL } = require('./settings');

class Pay153HttpError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'Pay153HttpError';
    this.code = 'PAY153_HTTP_ERROR';
    this.status = status;
    this.body = body;
  }
}

function isPublicProvider(settings) {
  return String(settings?.provider || 'pay153') === 'public_cdk';
}

function isGcTacmonProvider(settings) {
  return String(settings?.provider || 'pay153') === 'gc_tacmon';
}

function publicServiceProxyUrl(proxy) {
  if (!proxy || typeof proxy !== 'object') return '';
  const raw = String(proxy.raw || '').trim();
  if (raw && /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) return raw;
  const host = String(proxy.host || '').trim();
  const port = String(proxy.port || '').trim();
  if (!host || !port) {
    if (!raw) return '';
    const parts = raw.split(':');
    if (parts.length < 2) return '';
    const [rawHost, rawPort, username = '', ...passwordParts] = parts;
    const password = passwordParts.join(':');
    const auth = username || password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : '';
    return `http://${auth}${rawHost}:${rawPort}`;
  }
  const username = String(proxy.username || '');
  const password = String(proxy.password || '');
  const auth = username || password
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : '';
  return `http://${auth}${host}:${port}`;
}

function publicServiceProxyDispatcher(proxy) {
  const url = publicServiceProxyUrl(proxy);
  return url ? new ProxyAgent(url) : null;
}

function publicErrorMessage(payload, status) {
  return String(payload?.error || payload?.message || `public refining service returned HTTP ${status}`);
}

function gcTacmonErrorMessage(payload, status) {
  return String(payload?.detail || payload?.error || payload?.message || `GC 提炼 returned HTTP ${status}`);
}

function gcTacmonItemStatus(value) {
  const status = String(value || '').toLowerCase();
  if (['succeeded', 'success', 'done', 'completed'].includes(status)) return 'done';
  if (['failed', 'failure', 'error', 'cancelled'].includes(status)) return status === 'cancelled' ? 'cancelled' : 'error';
  if (['queued', 'pending'].includes(status)) return 'queued';
  return 'running';
}

function gcTacmonBatchFromJob(job = {}) {
  const items = Array.isArray(job.items) ? job.items : [];
  const children = items.length ? items.map((item, index) => {
    const rawStatus = gcTacmonItemStatus(item.status || job.status);
    const link = String(item.payment_link || item.paymentLink || item.result?.url || job.result?.url || '').trim();
    const status = link ? 'done' : rawStatus;
    return {
      index,
      email: String(item.email || item.label || `gcash-${index + 1}`),
      status,
      percent: Number(item.percent || (status === 'done' || status === 'error' ? 100 : 0)),
      text: link ? 'GC 初次链接已获取，本地接管二维码' : String(item.message || item.step_label || item.step_key || ''),
      result: link ? { url: link, checkout_url: link, payment_link: link } : (item.result && typeof item.result === 'object' ? item.result : null),
      error: status === 'done' ? null : (item.error || item.failure_reason || null),
      job_id: job.id || null,
    };
  }) : [{
    index: 0,
    email: 'gcash',
    status: gcTacmonItemStatus(job.status),
    percent: Number(job.percent || 0),
    text: String(job.error || ''),
    result: job.result && typeof job.result === 'object' ? job.result : null,
    error: job.error || null,
    job_id: job.id || null,
  }];
  const terminal = children.length > 0 && children.every((child) => ['done', 'error', 'cancelled'].includes(child.status));
  return {
    status: terminal ? 'done' : gcTacmonItemStatus(job.status),
    summary: job.item_summary || {
      total: children.length,
      done: children.filter((child) => child.status === 'done').length,
      error: children.filter((child) => child.status === 'error').length,
      pending: children.filter((child) => ['queued', 'running'].includes(child.status)).length,
    },
    children,
  };
}

function eventWorker(event, fallback = 0) {
  const parsed = Number(event?.worker ?? event?.index);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function parseSseBlock(block) {
  const data = String(block || '').split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data) return null;
  try { return JSON.parse(data); } catch { return null; }
}

function publicBatchFromEvents(events) {
  const children = new Map();
  let done = false;
  let summary = null;
  let nextIndex = 0;
  const ensure = (event) => {
    const index = eventWorker(event, nextIndex);
    nextIndex = Math.max(nextIndex, index + 1);
    const child = children.get(index) || {
      index,
      email: String(event?.email || event?.label || ''),
      status: 'running',
      percent: 0,
      text: '',
      result: null,
      error: null,
    };
    if (event?.email) child.email = String(event.email);
    else if (!child.email) child.email = String(event?.label || '');
    children.set(index, child);
    return child;
  };
  for (const event of events) {
    const type = String(event?.type || '');
    if (type === 'summary') {
      summary = {
        total: Number(event.total || 0),
        done: Number(event.done || 0),
        error: Number(event.failed || event.error || 0),
        pending: Number(event.pending || 0),
        quota: Number(event.quota || 0),
        elapsed: Number(event.elapsed || 0),
      };
    } else if (type === 'begin') {
      const child = ensure(event);
      child.status = 'running';
      child.percent = Number(event.percent || 1);
      child.text = 'public refining started';
    } else if (type === 'retry') {
      const child = ensure(event);
      child.status = 'running';
      child.text = `retry ${Number(event.attempt || 0)}/${Number(event.max || 0)}`;
    } else if (type === 'stage') {
      const child = ensure(event);
      child.status = 'running';
      child.percent = Number(event.percent || child.percent || 0);
      child.text = String(event.stageLabel || event.stage || child.text || '');
    } else if (type === 'result') {
      const child = ensure(event);
      const ok = Boolean(event.ok);
      const url = String(event.url || '');
      child.status = ok ? 'done' : 'error';
      child.percent = 100;
      child.text = ok ? 'public refining completed' : 'public refining failed';
      child.result = ok ? { url, checkout_url: url } : null;
      child.error = ok ? null : String(event.error || 'public_refining_failed');
    } else if (type === 'done') {
      done = true;
    }
  }
  const values = [...children.values()].sort((a, b) => a.index - b.index);
  const allTerminal = values.length > 0 && values.every((child) => ['done', 'error'].includes(child.status));
  if (!summary) {
    summary = {
      total: values.length,
      done: values.filter((child) => child.status === 'done').length,
      error: values.filter((child) => child.status === 'error').length,
      pending: values.filter((child) => child.status === 'running').length,
    };
  }
  return { status: done || allTerminal ? 'done' : 'running', summary, children: values };
}

class Pay153Client {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 15000, streamWaitMs = 1800, config = null } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.streamWaitMs = streamWaitMs;
    this.config = config;
    this.publicStreams = new Map();
    this.publicStreamMaxMs = 10 * 60 * 1000;
    this.mkGcashProcess = null;
    this.mkGcashBaseUrl = String(process.env.MK_GCASH_BASE_URL || 'http://127.0.0.1:18931').replace(/\/+$/u, '');
  }

  async request(settings, pathname, { method = 'GET', body = null, idempotencyKey = '' } = {}) {
    const headers = { accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    if (settings.internalKey) headers['x-pay153-internal-key'] = settings.internalKey;
    if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;
    const response = await this.fetchImpl(`${settings.serviceBaseUrl}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      throw new Pay153HttpError(payload?.error || `PAY.153 returned HTTP ${response.status}`, {
        status: response.status,
        body: payload,
      });
    }
    return payload || {};
  }

  async publicJson(settings, pathname, body, { dispatcher = null } = {}) {
    if (!PUBLIC_REFINING_BASE_URL) throw new Error('PUBLIC_REFINING_BASE_URL is not configured');
    if (!String(settings.publicCdk || '').trim()) throw new Error('public refining CDK is not configured');
    const response = await this.fetchImpl(`${PUBLIC_REFINING_BASE_URL}${pathname}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(dispatcher ? { dispatcher } : {}),
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok || payload?.ok === false) {
      throw new Pay153HttpError(publicErrorMessage(payload, response.status), {
        status: response.ok && payload?.ok === false ? 400 : response.status,
        body: payload,
      });
    }
    return payload || {};
  }

  async gcTacmonJson(settings, pathname, { method = 'GET', body = null } = {}) {
    if (!GC_TACMON_BASE_URL) throw new Error('GC_TACMON_BASE_URL is not configured');
    const dispatcher = publicServiceProxyDispatcher(settings.gcTacmonSiteProxy);
    try {
      const response = await this.fetchImpl(`${GC_TACMON_BASE_URL}${pathname}`, {
        method,
        headers: body ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(dispatcher ? { dispatcher } : {}),
      });
      let payload = null;
      try { payload = await response.json(); } catch {}
      if (!response.ok || payload?.ok === false) {
        throw new Pay153HttpError(gcTacmonErrorMessage(payload, response.status), {
          status: response.ok && payload?.ok === false ? 400 : response.status,
          body: payload,
        });
      }
      return payload || {};
    } finally {
      await dispatcher?.close?.().catch(() => {});
    }
  }

  async startGcTacmonBatchInBrowser(settings, body) {
    if (!GC_TACMON_BASE_URL) throw new Error('GC_TACMON_BASE_URL is not configured');
    if (!this.config) throw new Error('GC 提炼 需要浏览器配置，不能用纯后端直连提交');
    const operationTimeoutMs = Math.max(45000, Number(this.config.browser?.operationTimeoutMs || 30000));
    const browserConfig = {
      ...this.config,
      browser: {
        ...(this.config.browser || {}),
        blockImages: false,
      },
    };
    const browserSession = await createFingerprintBrowserSession({
      config: browserConfig,
      proxy: settings.gcTacmonSiteProxy || null,
    });
    try {
      const page = browserSession.page;
      await page.goto(GC_TACMON_BASE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: operationTimeoutMs,
      });
      await page.waitForSelector('#session', { timeout: operationTimeoutMs });
      await page.fill('#session', String(body.session_text || ''));
      await page.fill('#proxyPool', String(body.proxy_pool || ''));
      const attemptLimit = String(Math.max(1, Number(body.attempt_limit || 1)));
      await page.evaluate((value) => {
        const select = document.getElementById('attemptLimit');
        if (!select) return;
        if (![...select.options].some((option) => option.value === value || option.textContent === value)) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = value;
          select.appendChild(option);
        }
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }, attemptLimit);
      const turnstileRequired = await page.evaluate(async () => {
        const response = await fetch('/api/config', { cache: 'no-store' });
        const config = await response.json().catch(() => ({}));
        return Boolean(config.turnstile_enabled);
      }).catch(() => true);
      if (turnstileRequired) {
        try {
          await page.waitForFunction(() => Boolean(window.turnstile), null, { timeout: operationTimeoutMs });
          await page.waitForTimeout(15000);
          const statusText = await page.locator('#status').textContent({ timeout: 1000 }).catch(() => '');
          if (/组件加载失败|load failed|failed/i.test(statusText || '')) {
            throw new Error(statusText);
          }
        } catch (error) {
          const diagnostics = await page.evaluate(() => ({
            url: location.href,
            title: document.title,
            statusText: document.getElementById('status')?.textContent || '',
            turnstileAreaText: document.getElementById('turnstileArea')?.textContent || '',
            iframeCount: document.querySelectorAll('iframe[src*=\"challenges.cloudflare.com\"]').length,
            hasTurnstileObject: Boolean(window.turnstile),
          })).catch(() => null);
          const detail = diagnostics ? JSON.stringify(diagnostics) : String(error?.message || error);
          throw new Pay153HttpError(`GC 提炼 Turnstile 组件不可用：${detail}`, {
            status: 408,
            body: diagnostics || { message: String(error?.message || error) },
          });
        }
      }
      const submitTimeoutMs = Math.max(120000, this.timeoutMs * 8);
      let response = null;
      const submitStartedAt = Date.now();
      let lastDiagnostics = null;
      while (!response && Date.now() - submitStartedAt < submitTimeoutMs) {
        const responsePromise = page.waitForResponse((candidate) => {
          return candidate.url().includes('/api/jobs/gcash-web') && candidate.request().method() === 'POST';
        }, { timeout: 12000 }).catch(() => null);
        await page.waitForSelector('#start', { state: 'attached', timeout: operationTimeoutMs });
        await page.evaluate(() => {
          const button = document.getElementById('start');
          if (!button) throw new Error('GC 提炼 start button not found');
          if (button.disabled) throw new Error('GC 提炼 start button is disabled');
          button.scrollIntoView({ block: 'center', inline: 'center' });
          button.click();
        });
        response = await responsePromise;
        if (response) break;
        lastDiagnostics = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          statusText: document.getElementById('status')?.textContent || '',
          turnstileAreaText: document.getElementById('turnstileArea')?.textContent || '',
          iframeCount: document.querySelectorAll('iframe[src*=\"challenges.cloudflare.com\"]').length,
          hasTurnstileObject: Boolean(window.turnstile),
        })).catch(() => null);
        const statusText = String(lastDiagnostics?.statusText || '');
        if (/组件加载失败|load failed|failed/i.test(statusText)) break;
        if (!/请先完成|人机验证|Cloudflare/i.test(statusText)) break;
        await page.waitForTimeout(10000);
      }
      if (!response) {
        const diagnostics = lastDiagnostics || await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          statusText: document.getElementById('status')?.textContent || '',
          turnstileAreaText: document.getElementById('turnstileArea')?.textContent || '',
          iframeCount: document.querySelectorAll('iframe[src*=\"challenges.cloudflare.com\"]').length,
          hasTurnstileObject: Boolean(window.turnstile),
        })).catch(() => null);
        const detail = diagnostics ? JSON.stringify(diagnostics) : 'no response';
        throw new Pay153HttpError(`GC 提炼 页面未发出提交请求：${detail}`, {
          status: 408,
          body: diagnostics || { message: 'no response' },
        });
      }
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { detail: text || `HTTP ${response.status()}` }; }
      if (!response.ok() || payload?.ok === false) {
        const statusText = await page.locator('#status').textContent({ timeout: 1000 }).catch(() => '');
        throw new Pay153HttpError(gcTacmonErrorMessage(payload, response.status()) || statusText || `GC 提炼 returned HTTP ${response.status()}`, {
          status: response.status(),
          body: payload,
        });
      }
      return payload || {};
    } finally {
      await browserSession.close().catch(() => {});
    }
  }

  mkGcashEnv() {
    const dataDir = String(this.config?.dataDir || '/var/lib/signlist-clean/data');
    return {
      ...process.env,
      MK_HOST: process.env.MK_GCASH_HOST || '127.0.0.1',
      MK_PORT: process.env.MK_GCASH_PORT || '18931',
      MK_MAX_CONCURRENCY: String(Math.max(1, Math.min(12, Number(process.env.MK_MAX_CONCURRENCY || 4) || 4))),
      MK_MAX_SESSION_CONCURRENCY: String(Math.max(1, Math.min(12, Number(process.env.MK_MAX_SESSION_CONCURRENCY || 4) || 4))),
      MK_MAX_QUEUE: String(Math.max(1, Math.min(200, Number(process.env.MK_MAX_QUEUE || 50) || 50))),
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(path.dirname(dataDir), 'playwright-browsers'),
    };
  }

  mkGcashPaths() {
    const root = process.env.MK_GCASH_ROOT || path.join(process.cwd(), 'vendor', 'mk-gcash-link-opensource');
    const python = process.env.MK_GCASH_PYTHON || '/var/lib/signlist-clean/mk-gcash-venv/bin/python';
    return { root, python };
  }

  async mkGcashFetch(pathname, { method = 'GET', body = null, timeoutMs = null } = {}) {
    const response = await this.fetchImpl(`${this.mkGcashBaseUrl}${pathname}`, {
      method,
      headers: body ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs || this.timeoutMs),
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    let payload = null;
    if (contentType.includes('json')) {
      try { payload = await response.json(); } catch {}
    } else {
      const text = await response.text().catch(() => '');
      payload = text ? { error: text } : {};
    }
    if (!response.ok) {
      throw new Pay153HttpError(payload?.error || payload?.message || `MK GCash returned HTTP ${response.status}`, {
        status: response.status,
        body: payload,
      });
    }
    return payload || {};
  }

  async ensureMkGcashSidecar() {
    try {
      return await this.mkGcashFetch('/api/health', { timeoutMs: 2000 });
    } catch {}
    const { root, python } = this.mkGcashPaths();
    if (!this.mkGcashProcess || this.mkGcashProcess.exitCode !== null) {
      this.mkGcashProcess = spawn(python, ['app.py'], {
        cwd: root,
        env: this.mkGcashEnv(),
        stdio: 'ignore',
        detached: false,
      });
      this.mkGcashProcess.on('exit', () => { this.mkGcashProcess = null; });
      this.mkGcashProcess.unref?.();
    }
    const deadline = Date.now() + 20000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        return await this.mkGcashFetch('/api/health', { timeoutMs: 2000 });
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw lastError || new Error('MK GCash sidecar did not become ready');
  }

  async mkGcashQrBase64(jobId, accountId) {
    const response = await this.fetchImpl(`${this.mkGcashBaseUrl}/api/jobs/${encodeURIComponent(jobId)}/accounts/${encodeURIComponent(accountId)}/qr.png`, {
      method: 'GET',
      signal: AbortSignal.timeout(Math.max(5000, this.timeoutMs)),
    });
    if (!response.ok) return '';
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length ? buffer.toString('base64') : '';
  }

  async startMkGcashBatch(settings, payload) {
    await this.ensureMkGcashSidecar();
    const accounts = Array.isArray(payload.accounts) && payload.accounts.length
      ? payload.accounts.map((account) => ({
        access_token: String(account.access_token || account.token || '').trim(),
        email: String(account.email || '').trim(),
        name: String(account.name || '').trim(),
      }))
      : (payload.tokens || []).map((token) => ({ access_token: String(token || '').trim() }));
    const proxyPool = Array.isArray(settings.gcTacmonWorkerProxyLines)
      ? settings.gcTacmonWorkerProxyLines.map((line) => String(line || '').trim()).filter(Boolean)
      : String(settings.gcTacmonWorkerProxyLine || '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (!accounts.some((account) => account.access_token)) throw new Error('MK GCash 需要账号 Access Token');
    if (!proxyPool.length) throw new Error('MK GCash 需要 GC 执行代理池');
    const response = await this.mkGcashFetch('/api/jobs', {
      method: 'POST',
      body: {
        accounts,
        proxy_pool: proxyPool,
        max_attempts: Math.max(1, Math.min(10, Number(payload.retry_count || 1) || 1)),
      },
      timeoutMs: Math.max(30000, this.timeoutMs * 2),
    });
    const batchId = String(response.job_id || '').trim();
    if (!batchId) throw new Error('MK GCash accepted the request without a job id');
    return { batch_id: batchId, total: Array.isArray(response.accounts) ? response.accounts.length : accounts.length };
  }

  async refreshMkGcashAccount(jobId, accountId) {
    await this.ensureMkGcashSidecar();
    return this.mkGcashFetch(`/api/jobs/${encodeURIComponent(jobId)}/accounts/${encodeURIComponent(accountId)}/refresh`, {
      method: 'POST',
      body: {},
      timeoutMs: Math.max(30000, this.timeoutMs * 2),
    });
  }

  async cancelMkGcashBatch(batchId) {
    await this.ensureMkGcashSidecar();
    const id = String(batchId || '').trim();
    if (!id) throw new Error('MK GCash cancel requires a job id');
    let cancelResult = null;
    let cancelError = null;
    try {
      cancelResult = await this.mkGcashFetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        body: {},
        timeoutMs: Math.max(30000, this.timeoutMs * 2),
      });
    } catch (error) {
      cancelError = error;
    }
    let abandonResult = null;
    let abandonError = null;
    try {
      abandonResult = await this.mkGcashFetch(`/api/jobs/${encodeURIComponent(id)}/abandon`, {
        method: 'POST',
        body: {},
        timeoutMs: Math.max(30000, this.timeoutMs * 2),
      });
    } catch (error) {
      abandonError = error;
    }
    if (!cancelResult && !abandonResult) throw cancelError || abandonError || new Error('MK GCash cancel failed');
    return { ok: true, cancel: cancelResult, abandon: abandonResult, abandonError: abandonError ? String(abandonError.message || abandonError) : null };
  }

  async abandonMkGcashAccount(jobId, accountId) {
    await this.ensureMkGcashSidecar();
    return this.mkGcashFetch(`/api/jobs/${encodeURIComponent(jobId)}/accounts/${encodeURIComponent(accountId)}/abandon`, {
      method: 'POST',
      body: {},
      timeoutMs: Math.max(15000, this.timeoutMs),
    });
  }

  async getMkGcashBatch(batchId) {
    await this.ensureMkGcashSidecar();
    const job = await this.mkGcashFetch(`/api/jobs/${encodeURIComponent(batchId)}`, { timeoutMs: Math.max(10000, this.timeoutMs) });
    const accounts = Array.isArray(job.accounts) ? job.accounts : [];
    const children = await Promise.all(accounts.map(async (account, index) => {
      const rawTaskStatus = String(account.status || '').toLowerCase();
      const paymentStatus = String(account.payment_status || '').toLowerCase();
      const linkReady = Boolean(account.link_ready || account.link);
      const paymentTerminalError = ['callback_failed', 'callback_unconfirmed', 'abandoned'].includes(paymentStatus);
      const status = account.payment_success
        ? 'done'
        : paymentTerminalError || rawTaskStatus === 'failed'
          ? 'error'
          : 'running';
      const qrImageBase64 = account.qr_ready && account.id
        ? await this.mkGcashQrBase64(job.job_id || batchId, account.id).catch(() => '')
        : '';
      const result = linkReady || account.qr_ready || paymentStatus ? {
        url: account.link || '',
        checkout_url: account.link || '',
        payment_link: account.link || '',
        mkGcash: true,
        mkJobId: job.job_id || batchId,
        mkAccountId: account.id || '',
        qrReady: Boolean(account.qr_ready),
        qrImageBase64,
        qrVersion: Number(account.qr_version || 0),
        qrSource: account.qr_source || '',
        expiresAt: account.expires_at || null,
        refreshAvailable: Boolean(account.refresh_available),
        paymentStatus,
        paymentSuccess: Boolean(account.payment_success),
        currentStep: account.current_step || '',
        steps: Array.isArray(account.steps) ? account.steps : [],
        attemptsUsed: Number(account.attempts_used || 0),
      } : null;
      return {
        index,
        email: String(account.email || account.name || `mk-gcash-${index + 1}`),
        status,
        percent: account.payment_success ? 100 : (linkReady ? 90 : Math.max(1, Number(account.queue_position ? 1 : 10))),
        text: account.payment_success
          ? 'MK GCash 已确认 Plus 到账'
          : linkReady
            ? `MK GCash 二维码/回调监控中：${paymentStatus || 'waiting_scan'}`
            : String(account.current_step || 'MK GCash 提链中'),
        result,
        error: status === 'error' ? String(account.error || paymentStatus || 'mk_gcash_failed') : null,
        job_id: account.id || null,
      };
    }));
    const terminal = children.length > 0 && children.every((child) => ['done', 'error', 'cancelled'].includes(child.status));
    return {
      status: terminal ? 'done' : 'running',
      summary: {
        total: children.length,
        done: children.filter((child) => child.status === 'done').length,
        error: children.filter((child) => child.status === 'error').length,
        pending: children.filter((child) => ['queued', 'running'].includes(child.status)).length,
      },
      children,
    };
  }

  supportsIdempotency(settings) {
    return !isPublicProvider(settings);
  }

  async availableQuota(settings) {
    if (!isPublicProvider(settings)) return Number.POSITIVE_INFINITY;
    const payload = await this.publicJson(settings, '/api/verify', { cdk: settings.publicCdk });
    const remaining = Number(payload.remaining);
    if (!Number.isFinite(remaining) || remaining < 0) throw new Error('public refining service returned invalid remaining quota');
    return { remaining: Math.trunc(remaining), quota: Number(payload.quota || 0), used: Number(payload.used || 0) };
  }

  health(settings) {
    if (isPublicProvider(settings)) {
      return this.availableQuota(settings).then((quota) => ({ ok: true, provider: 'public_cdk', ...quota }));
    }
    if (isGcTacmonProvider(settings)) {
      return this.ensureMkGcashSidecar().then((health) => ({ ...health, provider: 'gc_tacmon', engine: 'mk_gcash_local' }));
    }
    return this.request(settings, '/api/health');
  }

  capabilities(settings) {
    if (isPublicProvider(settings)) {
      return Promise.resolve({
        provider: 'public_cdk',
        task_limits: { workers: 30, retries: 50 },
        fixed_service_url: PUBLIC_REFINING_BASE_URL,
      });
    }
    if (isGcTacmonProvider(settings)) {
      return Promise.resolve({
        provider: 'gc_tacmon',
        engine: 'mk_gcash_local',
        task_limits: { workers: 12, retries: 10 },
        fixed_service_url: this.mkGcashBaseUrl,
        link_types: ['gcash'],
      });
    }
    return this.request(settings, '/api/config');
  }

  async startBatch(settings, payload, idempotencyKey) {
    if (isGcTacmonProvider(settings)) {
      return this.startMkGcashBatch(settings, payload);
    }
    if (!isPublicProvider(settings)) {
      return this.request(settings, '/api/checkout-batch', { method: 'POST', body: payload, idempotencyKey });
    }
    const dispatcher = publicServiceProxyDispatcher(settings.publicTransportProxy);
    let response;
    try {
      response = await this.publicJson(settings, '/api/run', {
        cdk: settings.publicCdk,
        tokens: (payload.tokens || []).join('\n'),
        retries: Number(payload.retry_count || 1),
        auto_paypal: false,
        paypal_cdk: '',
      }, { dispatcher });
    } catch (error) {
      await dispatcher?.close?.().catch(() => {});
      throw error;
    }
    const batchId = String(response.job || '');
    if (!batchId) {
      await dispatcher?.close?.().catch(() => {});
      throw new Error('public refining service accepted the request without a job id');
    }
    this.ensurePublicStream(batchId, {
      proxy: settings.publicTransportProxy || null,
      dispatcher,
    });
    return { batch_id: batchId, total: Number(response.total || payload.tokens?.length || 0) };
  }

  notifyPublicStream(state) {
    state.version += 1;
    for (const resolve of state.waiters.splice(0)) resolve();
  }

  ensurePublicStream(batchId, { proxy = null, dispatcher = null } = {}) {
    let state = this.publicStreams.get(batchId);
    if (!state) {
      state = {
        events: [],
        done: false,
        error: null,
        errorSnapshotDelivered: false,
        promise: null,
        version: 0,
        waiters: [],
        proxy,
        dispatcher: dispatcher || publicServiceProxyDispatcher(proxy),
      };
      this.publicStreams.set(batchId, state);
    } else {
      if (!state.proxy && proxy) state.proxy = proxy;
      if (!state.done && !state.error && !state.dispatcher) {
        state.dispatcher = dispatcher || publicServiceProxyDispatcher(state.proxy);
      }
    }
    if (!state.done && !state.error && !state.promise) {
      state.promise = this.consumePublicStream(batchId, state).finally(() => {
        state.promise = null;
        this.notifyPublicStream(state);
      });
    }
    return state;
  }

  async consumePublicStream(batchId, state) {
    try {
      if (!PUBLIC_REFINING_BASE_URL) throw new Error('PUBLIC_REFINING_BASE_URL is not configured');
      const response = await this.fetchImpl(`${PUBLIC_REFINING_BASE_URL}/api/stream?job=${encodeURIComponent(batchId)}`, {
        headers: { accept: 'text/event-stream' },
        signal: AbortSignal.timeout(this.publicStreamMaxMs),
        ...(state.dispatcher ? { dispatcher: state.dispatcher } : {}),
      });
      if (!response.ok) {
        let payload = null;
        try { payload = await response.json(); } catch {}
        throw new Pay153HttpError(publicErrorMessage(payload, response.status), {
          status: response.status,
          body: payload,
        });
      }
      const reader = response.body?.getReader?.();
      if (!reader) throw new Error('public refining stream body is unavailable');
      const decoder = new TextDecoder();
      let buffer = '';
      while (!state.done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/u);
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const event = parseSseBlock(block);
          if (!event) continue;
          state.events.push(event);
          if (event.type === 'done') state.done = true;
          this.notifyPublicStream(state);
        }
      }
      if (!state.done) throw new Error('public refining stream ended before the done event');
    } catch (error) {
      state.error = error;
      state.errorSnapshotDelivered = false;
    } finally {
      await state.dispatcher?.close?.().catch(() => {});
      state.dispatcher = null;
    }
  }

  waitForPublicStreamUpdate(state) {
    return new Promise((resolve) => {
      let waiter;
      const timer = setTimeout(() => {
        state.waiters = state.waiters.filter((entry) => entry !== waiter);
        resolve();
      }, this.streamWaitMs);
      waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      state.waiters.push(waiter);
    });
  }

  async getPublicBatch(batchId, proxy = null) {
    const state = this.ensurePublicStream(batchId, { proxy });
    if (!state.events.length && !state.error && !state.done) await this.waitForPublicStreamUpdate(state);
    const batch = publicBatchFromEvents(state.events);
    batch.status = state.done ? 'done' : 'running';
    if (state.error) {
      if (state.events.length && !state.errorSnapshotDelivered) {
        state.errorSnapshotDelivered = true;
        return batch;
      }
      const error = state.error;
      this.publicStreams.delete(batchId);
      throw error;
    }
    return batch;
  }

  async getBatch(settings, batchId) {
    if (isGcTacmonProvider(settings)) {
      return this.getMkGcashBatch(batchId);
    }
    if (isPublicProvider(settings)) return this.getPublicBatch(batchId, settings.publicTransportProxy || null);
    return this.request(settings, `/api/checkout-batch-progress?batch_id=${encodeURIComponent(batchId)}`);
  }

  cancelBatch(settings, batchId) {
    if (isGcTacmonProvider(settings)) return this.cancelMkGcashBatch(batchId);
    if (isPublicProvider(settings)) throw new Error('public refining jobs cannot be cancelled after submission');
    return this.request(settings, '/api/checkout-batch-cancel', {
      method: 'POST',
      body: { batch_id: batchId },
    });
  }
}

module.exports = {
  Pay153Client,
  Pay153HttpError,
  isPublicProvider,
  isGcTacmonProvider,
  parseSseBlock,
  publicBatchFromEvents,
  publicServiceProxyUrl,
};
