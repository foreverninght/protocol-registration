'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

class UniversalPaymentProbeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'UniversalPaymentProbeError';
    this.code = details.code || 'CLEAN_PAYMENT_DETECT_FAILED';
    this.retryableProxy = details.retryableProxy === true;
    this.failurePool = details.failurePool || 'payment_unknown';
    this.details = details.details || null;
  }
}

function intValue(value, fallback, min, max) {
  const parsed = Number(value);
  const number = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.max(min, Math.min(max, number));
}

function lastJsonLine(value = '') {
  const lines = String(value || '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return null;
}

function authFailure(message = '') {
  return /token_invalidated|authentication token|invalidated|unauthori[sz]ed|http 401|access token|登录态|认证|鉴权/iu.test(String(message || ''));
}

function proxyFailure(message = '') {
  const text = String(message || '');
  if (authFailure(text)) return false;
  return /proxy|代理|tunnel|connect|network|timeout|timed out|http 407|http 429/iu.test(text);
}

async function runUniversalPaymentMethodProbe({
  accessToken,
  proxyRef,
  timeoutMs = 180000,
  pythonPath = process.env.PAYMENT_PROBE_PYTHON || process.env.FREEPP_PYTHON || 'python',
  bridgePath = path.join(__dirname, 'probe_bridge.py'),
  pay153Root = process.env.PAY153_RUNTIME_ROOT || path.resolve(__dirname, '../../optional/pay153'),
  maxProxyAttempts = 1,
} = {}) {
  const token = String(accessToken || '').trim();
  const proxy = String(proxyRef || '').trim();
  if (!token) throw new UniversalPaymentProbeError('payment detection requires access token', {
    code: 'CLEAN_PAYMENT_DETECT_ACCESS_TOKEN_REQUIRED',
  });
  if (!proxy) throw new UniversalPaymentProbeError('payment detection requires a leased proxy', {
    code: 'CLEAN_PAYMENT_DETECT_PROXY_REQUIRED',
  });
  const effectiveTimeout = intValue(timeoutMs, 180000, 10000, 600000);

  return await new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [bridgePath], {
      cwd: path.dirname(bridgePath),
      env: { ...process.env, PAY153_RUNTIME_ROOT: pay153Root },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handler(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new UniversalPaymentProbeError(`payment detection timed out after ${effectiveTimeout}ms`, {
        code: 'CLEAN_PROXY_PRECHECK_FAILED',
        retryableProxy: true,
      }));
    }, effectiveTimeout);
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-2_000_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-100_000);
    });
    child.once('error', (error) => {
      finish(reject, new UniversalPaymentProbeError(`payment detector process failed: ${error.message}`, {
        code: 'CLEAN_PAYMENT_DETECT_PROCESS_FAILED',
      }));
    });
    child.once('close', (code) => {
      const payload = lastJsonLine(stdout);
      if (code === 0 && payload?.ok) {
        finish(resolve, payload);
        return;
      }
      const message = String(payload?.error?.message || stderr || `payment detector exited with code ${code}`).trim();
      const authStale = authFailure(message);
      const retryableProxy = proxyFailure(message);
      finish(reject, new UniversalPaymentProbeError(message, {
        code: authStale ? 'CLEAN_PAYMENT_DETECT_AUTH_STALE' : (retryableProxy ? 'CLEAN_PROXY_PRECHECK_FAILED' : 'CLEAN_PAYMENT_DETECT_FAILED'),
        retryableProxy,
        details: { detectorErrorType: payload?.error?.type || '', exitCode: code, authStale },
      }));
    });
    child.stdin.end(JSON.stringify({ accessToken: token, proxyPool: proxy.split(/\r?\n/u).filter(Boolean), maxProxyAttempts }));
  });
}

module.exports = {
  UniversalPaymentProbeError,
  authFailure,
  lastJsonLine,
  runUniversalPaymentMethodProbe,
};
