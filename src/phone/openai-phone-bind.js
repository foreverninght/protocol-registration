'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const compact = raw.replace(/[\s().-]+/g, '');
  if (compact.startsWith('+')) return compact;
  if (/^\d{7,18}$/u.test(compact)) return `+${compact}`;
  return compact;
}

function proxyUrl(proxy) {
  if (!proxy || typeof proxy !== 'object') return '';
  const raw = String(proxy.raw || '').trim();
  if (raw) {
    if (/^https?:\/\//iu.test(raw)) return raw;
    const parts = raw.split(':');
    if (parts.length >= 4) {
      const [host, port, username, ...passwordParts] = parts;
      const password = passwordParts.join(':');
      return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    }
    return `http://${raw}`;
  }
  const host = String(proxy.host || '').trim();
  const port = String(proxy.port || '').trim();
  if (!host || !port) return '';
  const username = String(proxy.username || '').trim();
  const password = String(proxy.password || '').trim();
  const auth = username || password
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : '';
  return `http://${auth}${host}:${port}`;
}

function reusablePhoneBindAuth(account) {
  const source = account?.oauthSession?.phoneBindAuth || account?.oauthSession?.phone_bind_auth || {};
  if (!source || typeof source !== 'object') return {};
  const accountSelectSessionId = String(source.accountSelectSessionId || source.account_select_session_id || source.session_id || '').trim();
  const sub2SessionId = String(source.sub2SessionId || source.sub2_session_id || '').trim();
  const oauthState = String(source.oauthState || source.oauth_state || '').trim();
  const addPhoneUrl = String(source.addPhoneUrl || source.add_phone_url || source.continue_url || '').trim();
  const cookieHeaders = source.cookieHeaders && typeof source.cookieHeaders === 'object'
    ? source.cookieHeaders
    : source.cookie_headers && typeof source.cookie_headers === 'object'
      ? source.cookie_headers
      : {};
  const cookies = [
    ...(Array.isArray(source.cookies) ? source.cookies : []),
    ...Object.entries(cookieHeaders).flatMap(([domain, header]) => cookiesFromHeader(header, domain)),
  ].map(normalizeCookie).filter(Boolean);
  if (!accountSelectSessionId || !sub2SessionId || !oauthState || !addPhoneUrl || !cookies.length) return {};
  return {
    accountSelectSessionId,
    sub2SessionId,
    oauthState,
    addPhoneUrl,
    cookies,
    capturedAt: source.capturedAt || source.captured_at || null,
    source: source.source || 'freepp_sub2_auth_url',
  };
}

function hasReusablePhoneBindAuth(account) {
  return Boolean(reusablePhoneBindAuth(account).accountSelectSessionId);
}

function hasPhoneBindOauthQualification(account) {
  return Boolean(
    account?.phoneBindOauthQualified === true
      || account?.phoneBindOauthQualification?.qualified === true
      || hasReusablePhoneBindAuth(account),
  );
}

function savedPhoneBindAuth(account) {
  return reusablePhoneBindAuth(account);
}
function normalizeCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') return null;
  const name = String(cookie.name || '').trim();
  const value = String(cookie.value || '');
  if (!name || !value) return null;
  const domain = String(cookie.domain || '').trim();
  return {
    name,
    value,
    domain: domain || undefined,
    path: String(cookie.path || '/'),
    httpOnly: Boolean(cookie.httpOnly),
    secure: cookie.secure !== false,
    sameSite: cookie.sameSite || undefined,
    ...(Number.isFinite(Number(cookie.expires)) ? { expires: Number(cookie.expires) } : {}),
  };
}

function cookiesFromHeader(header, domain) {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator <= 0) return null;
      return normalizeCookie({
        name: part.slice(0, separator).trim(),
        value: part.slice(separator + 1).trim(),
        domain,
        path: '/',
        secure: true,
      });
    })
    .filter(Boolean);
}

function durableOpenAiIdentityCookies(account) {
  const cookies = Array.isArray(account?.oauthSession?.cookies)
    ? account.oauthSession.cookies
    : [];
  return cookies.filter((cookie) => {
    const name = String(cookie?.name || '').trim();
    const domain = String(cookie?.domain || '').trim().replace(/^\./u, '').toLowerCase();
    if (!['auth.openai.com', 'openai.com'].includes(domain)) return false;
    return name === 'unified_session_manifest'
      || name.startsWith('usc_')
      || name === 'oai-did'
      || name === 'oaicom-stable-id';
  });
}

function chatgptSessionCookiesForFreshAuthorization(account) {
  const sessionContext = account?.sessionContext || {};
  const sources = [
    Array.isArray(account?.session?.cookies) ? account.session.cookies : [],
    cookiesFromHeader(sessionContext.cookie, 'chatgpt.com'),
    durableOpenAiIdentityCookies(account),
  ];
  const seen = new Set();
  const cookies = sources
    .flat()
    .map(normalizeCookie)
    .filter((cookie) => {
      if (!cookie) return false;
      if (['oai-client-auth-session', 'oai-client-auth-info', 'hydra_redirect', 'iss_context', 'rg_context']
        .includes(cookie.name) || cookie.name.startsWith('oai-login-csrf_')) return false;
      const key = `${cookie.domain || ''}|${cookie.path || '/'}|${cookie.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (!cookies.length) {
    const error = new Error('account has no saved ChatGPT session cookies for a new authorization');
    error.code = 'PHONE_BIND_SESSION_MISSING';
    throw error;
  }
  return cookies;
}

function pythonForConfig(config = {}) {
  return config.registration?.freepp?.python
    || process.env.PHONE_BIND_PYTHON
    || process.env.FREEPP_PYTHON
    || process.env.PYTHON
    || 'python3';
}

function protocolScriptPath() {
  return path.resolve(__dirname, '..', '..', 'tools', 'openai_phone_bind_protocol.py');
}

function stateKey(email, phone) {
  return crypto.createHash('sha256')
    .update(`${String(email || '').toLowerCase()}\n${String(phone || '')}`)
    .digest('hex')
    .slice(0, 24);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJsonFile(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

const PHONE_BIND_WORKFLOW_STAGES = Object.freeze({
  AUTHORIZATION_READY: 'authorization_ready',
  OTP_REQUIRED: 'otp_required',
  RT_PENDING: 'rt_pending',
  COMPLETED: 'completed',
});

function phoneBindWorkflowStage(state = {}) {
  const explicit = String(state.workflow_stage || '').trim();
  if (Object.values(PHONE_BIND_WORKFLOW_STAGES).includes(explicit)) return explicit;
  if (String(state.refresh_token || '').trim()) return PHONE_BIND_WORKFLOW_STAGES.COMPLETED;
  if (String(state.oauth_code || '').trim() && String(state.oauth_state || '').trim()) {
    return PHONE_BIND_WORKFLOW_STAGES.RT_PENDING;
  }
  if (
    String(state.phone || '').trim()
      && String(state.session_id || '').trim()
      && String(state.sub2_session_id || '').trim()
      && Array.isArray(state.cookies)
  ) {
    return PHONE_BIND_WORKFLOW_STAGES.OTP_REQUIRED;
  }
  if (
    state.authorization_ready
      && String(state.session_id || '').trim()
      && String(state.sub2_session_id || '').trim()
  ) {
    return PHONE_BIND_WORKFLOW_STAGES.AUTHORIZATION_READY;
  }
  return '';
}

function phoneBindRtPendingStateAvailable(state = {}) {
  return phoneBindWorkflowStage(state) === PHONE_BIND_WORKFLOW_STAGES.RT_PENDING
    && Boolean(String(state.oauth_code || '').trim())
    && Boolean(String(state.oauth_state || '').trim());
}

function persistPhoneBindWorkflowStage(stateFile, workflowStage, patch = {}) {
  const current = readJsonFile(stateFile);
  const next = {
    ...current,
    ...patch,
    workflow_stage: workflowStage,
    updated_at: Date.now(),
  };
  writeJsonAtomic(stateFile, next);
  return next;
}

async function persistDatabaseWorkflow({ store, email, stateFile, workflowStage, error = null }) {
  if (!store) throw new TypeError('database runtime state store is required for phone binding');
  const state = readJsonFile(stateFile);
  const stage = workflowStage || phoneBindWorkflowStage(state) || PHONE_BIND_WORKFLOW_STAGES.AUTHORIZATION_READY;
  await store.putPhoneBindWorkflow({
    email: String(email || '').trim().toLowerCase(),
    workflowStage: stage,
    state,
    cookies: Array.isArray(state.cookies) ? state.cookies : null,
    error,
  });
  return state;
}

async function materializeDatabaseWorkflow({ store, email, outputDir }) {
  if (!store) throw new TypeError('database runtime state store is required for phone binding');
  const workflow = await store.getPhoneBindWorkflow(email);
  if (!workflow) return null;
  const protocolDir = ensureDir(outputDir || path.join(os.tmpdir(), 'signlist-phone-bind-protocol'));
  const stateFile = path.join(protocolDir, `${stateKey(email, 'database-workflow')}.state.json`);
  const state = {
    ...(workflow.state || {}),
    ...(Array.isArray(workflow.cookies) ? { cookies: workflow.cookies } : {}),
    workflow_stage: workflow.workflowStage,
  };
  writeJsonAtomic(stateFile, state);
  return { workflow, protocolDir, stateFile, state };
}

function protocolOutputMessage(stdout, stderr, fallback) {
  const lines = String(stderr || stdout || '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return fallback;
  const failureIndex = lines.findIndex((line) => /^\[协议\] 失败:/u.test(line));
  const selected = failureIndex >= 0 ? lines.slice(failureIndex) : lines;
  return selected.join(' ').replace(/\s+/gu, ' ').slice(0, 1200) || fallback;
}

function protocolError(message, code = 'PHONE_BIND_PROTOCOL_FAILED', details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function runProtocol({ config, args, env = {}, timeoutMs = 90000 }) {
  return new Promise((resolve, reject) => {
    const python = pythonForConfig(config);
    const script = protocolScriptPath();
    const child = spawn(python, [script, ...args], {
      cwd: path.dirname(script),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
        PYTHONIOENCODING: 'utf-8',
      },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(protocolError(`phone bind protocol timed out after ${timeoutMs}ms`, 'PHONE_BIND_PROTOCOL_TIMEOUT', {
        stdout,
        stderr,
      }));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const line = protocolOutputMessage(stdout, stderr, `protocol exited with code ${code}`);
      return reject(protocolError(line, 'PHONE_BIND_PROTOCOL_FAILED', { stdout, stderr, exitCode: code }));
    });
  });
}

async function createPhoneBindSession({
  config,
  account,
  phone,
  phoneBindSettings,
  outputDir,
  proxy = null,
  authorizationOnly = false,
  runtimeStateStore,
}) {
  const normalizedPhone = normalizePhone(phone);
  if (!authorizationOnly && !normalizedPhone) {
    const error = new Error('phone number is required');
    error.code = 'PHONE_BIND_PHONE_REQUIRED';
    throw error;
  }
  if (!authorizationOnly && !/^\+\d{7,18}$/u.test(normalizedPhone)) {
    const error = new Error('phone number must include country code, for example 56977850651');
    error.code = 'PHONE_BIND_PHONE_INVALID';
    throw error;
  }
  const cookies = chatgptSessionCookiesForFreshAuthorization(account);
  const protocolDir = ensureDir(outputDir || path.join(os.tmpdir(), 'signlist-phone-bind-protocol'));
  const key = stateKey(account.email, authorizationOnly ? 'refresh-token' : normalizedPhone);
  const cookiesFile = path.join(protocolDir, `${key}.cookies.json`);
  const stateFile = path.join(protocolDir, `${key}.state.json`);
  writeJsonAtomic(cookiesFile, cookies);
  writeJsonAtomic(stateFile, {
    cookies,
    source: 'fresh_phone_bind_authorization',
    registration_oauth_reused: false,
    updated_at: Date.now(),
  });
  const settings = phoneBindSettings?.getSecretConfig?.() || {};
    const protocolEnv = {
      SUB2API_BASE_URL: String(settings.sub2BaseUrl || ''),
      SUB2API_ADMIN_API_KEY: String(settings.sub2AdminApiKey || ''),
      SUB2API_PROXY_ID: String(settings.sub2ProxyId || ''),
      SUB2API_REDIRECT_URI: String(settings.sub2RedirectUri || ''),
      PHONE_BIND_PROXY: proxyUrl(proxy),
      FREEPP_BACKEND_DIR: String(config.registration?.freepp?.backendDir || ''),
    };
  const protocolArgs = [
    '--stage', 'send',
    '--cookies-file', cookiesFile,
    '--state-file', stateFile,
    '--timeout', String(Math.ceil((config.browser?.operationTimeoutMs || 45000) / 1000)),
  ];
  if (!authorizationOnly) protocolArgs.push('--phone', normalizedPhone);
  if (authorizationOnly) protocolArgs.push('--authorization-only');
  if (protocolEnv.PHONE_BIND_PROXY) {
    protocolArgs.push('--proxy', protocolEnv.PHONE_BIND_PROXY);
  }

  try {
    await runProtocol({
      config,
      env: protocolEnv,
      args: protocolArgs,
      timeoutMs: Math.max(90000, Number(config.browser?.operationTimeoutMs || 45000) + 45000),
    });
  } catch (error) {
    writeJsonAtomic(`${stateFile}.error.json`, {
      failedAt: new Date().toISOString(),
      code: error?.code || 'PHONE_BIND_PROTOCOL_FAILED',
      message: String(error?.message || error),
      stdout: String(error?.stdout || '').slice(-24000),
      stderr: String(error?.stderr || '').slice(-24000),
      exitCode: error?.exitCode ?? null,
      freshAuthorization: true,
    });
    await persistDatabaseWorkflow({
      store: runtimeStateStore,
      email: account.email,
      stateFile,
      workflowStage: 'failed',
      error: { code: error?.code || 'PHONE_BIND_PROTOCOL_FAILED', message: String(error?.message || error) },
    });
    throw error;
  }

  const completedState = readJsonFile(stateFile);
  const phoneVerificationSkipped = Boolean(
    completedState.phone_verification_skipped
      && completedState.oauth_code
      && completedState.oauth_state
      && completedState.refresh_token,
  );
  persistPhoneBindWorkflowStage(
    stateFile,
    phoneVerificationSkipped
      ? PHONE_BIND_WORKFLOW_STAGES.COMPLETED
      : PHONE_BIND_WORKFLOW_STAGES.OTP_REQUIRED,
  );
  await persistDatabaseWorkflow({
    store: runtimeStateStore,
    email: account.email,
    stateFile,
    workflowStage: phoneVerificationSkipped
      ? PHONE_BIND_WORKFLOW_STAGES.COMPLETED
      : PHONE_BIND_WORKFLOW_STAGES.OTP_REQUIRED,
  });
  return {
    config,
    protocolEnv,
    protocol: 'openai_phone_bind_protocol',
    status: phoneVerificationSkipped ? 'completed' : 'otp_required',
    phone: phoneVerificationSkipped ? null : normalizedPhone,
    accountEmail: String(account.email || '').trim().toLowerCase(),
    runtimeStateStore,
    protocolDir,
    stateFile,
    cookiesFile,
    ...(phoneVerificationSkipped ? {
      oauthSession: {
        cookies: Array.isArray(completedState.cookies) ? completedState.cookies : [],
        workspaceId: String(completedState.workspace_id || ''),
        oauthCode: String(completedState.oauth_code || ''),
        oauthState: String(completedState.oauth_state || ''),
        refreshToken: String(completedState.refresh_token || ''),
        refreshTokenError: String(completedState.exchange_error || ''),
        capturedAt: new Date().toISOString(),
        source: 'openai_phone_bind_live_without_phone',
      },
    } : {}),
    async close() {
      await fs.promises.rm(this.cookiesFile, { force: true }).catch(() => {});
    },
  };
}

async function replacePhoneBindNumberWithFreshAuthorization(session, phone) {
  if (!session?.stateFile) {
    throw protocolError(
      'phone binding protocol state is not active',
      'PHONE_BIND_SESSION_NOT_ACTIVE',
    );
  }
  const normalizedPhone = normalizePhone(phone);
  if (!/^\+\d{7,18}$/u.test(normalizedPhone)) {
    throw protocolError(
      'phone number must include country code, for example 56977850651',
      'PHONE_BIND_PHONE_INVALID',
    );
  }

  const previousState = readJsonFile(session.stateFile);
  const cookies = Array.isArray(previousState.cookies) ? previousState.cookies : [];
  if (!cookies.length) {
    throw protocolError(
      '旧接码会话没有可用的 OAuth Cookie，无法重建换号授权步骤',
      'PHONE_BIND_OAUTH_COOKIES_MISSING',
    );
  }

  const protocolDir = ensureDir(session.protocolDir || path.dirname(session.stateFile));
  const key = stateKey(session.accountEmail || 'phone-bind', normalizedPhone);
  const cookiesFile = path.join(protocolDir, `${key}.cookies.json`);
  const stateFile = path.join(protocolDir, `${key}.state.json`);
  writeJsonAtomic(cookiesFile, cookies);
  writeJsonAtomic(stateFile, {
    cookies,
    source: 'fresh_phone_bind_authorization_after_otp_timeout',
    updated_at: Date.now(),
  });

  const timeoutSeconds = String(Math.ceil((session.config?.browser?.operationTimeoutMs || 45000) / 1000));
  const protocolArgs = [
    '--stage', 'send',
    '--phone', normalizedPhone,
    '--cookies-file', cookiesFile,
    '--state-file', stateFile,
    '--timeout', timeoutSeconds,
  ];
  if (session.protocolEnv?.PHONE_BIND_PROXY) {
    protocolArgs.push('--proxy', session.protocolEnv.PHONE_BIND_PROXY);
  }
  await runProtocol({
    config: session.config || {},
    env: session.protocolEnv || {},
    args: protocolArgs,
    timeoutMs: Math.max(
      90000,
      Number(session.config?.browser?.operationTimeoutMs || 45000) + 45000,
    ),
  });

  persistPhoneBindWorkflowStage(stateFile, PHONE_BIND_WORKFLOW_STAGES.OTP_REQUIRED);
  await persistDatabaseWorkflow({
    store: session.runtimeStateStore,
    email: session.accountEmail,
    stateFile,
    workflowStage: PHONE_BIND_WORKFLOW_STAGES.OTP_REQUIRED,
  });
  if (session.cookiesFile && session.cookiesFile !== cookiesFile) {
    await fs.promises.rm(session.cookiesFile, { force: true }).catch(() => {});
  }
  session.phone = normalizedPhone;
  session.stateFile = stateFile;
  session.cookiesFile = cookiesFile;
  session.protocolDir = protocolDir;
  session.close = async function close() {
    await fs.promises.rm(this.cookiesFile, { force: true }).catch(() => {});
  };
  return session;
}

async function reauthorizePhoneBindRefreshToken({
  config,
  account,
  phoneBindSettings,
  proxy,
  outputDir,
  runtimeStateStore,
  createSession = createPhoneBindSession,
}) {
  const recovery = await createSession({
    config,
    account,
    phone: '',
    phoneBindSettings,
    outputDir,
    proxy,
    authorizationOnly: true,
    runtimeStateStore,
  });
  try {
    const refreshToken = String(recovery.oauthSession?.refreshToken || '').trim();
    if (recovery.status !== 'completed' || !refreshToken) {
      throw protocolError(
        'fresh authorization did not return a refresh token',
        'PHONE_BIND_EXCHANGE_RECOVERY_INCOMPLETE',
      );
    }
    persistPhoneBindWorkflowStage(
      recovery.stateFile,
      PHONE_BIND_WORKFLOW_STAGES.COMPLETED,
    );
    return {
      status: 'completed',
      stateFile: recovery.stateFile,
      oauthSession: {
        ...(recovery.oauthSession || {}),
        refreshToken,
        refreshTokenError: '',
        capturedAt: new Date().toISOString(),
        source: 'openai_phone_bind_refresh_token_reauthorization',
      },
    };
  } finally {
    await recovery.close?.().catch(() => {});
  }
}

async function recoverPhoneBindExchangeWithFreshAuthorization({
  config,
  account,
  phoneBindSettings,
  proxy,
  outputDir,
  targetStateFile,
  runtimeStateStore,
  createSession = createPhoneBindSession,
}) {
  const materialized = await materializeDatabaseWorkflow({
    store: runtimeStateStore,
    email: account.email,
    outputDir: outputDir || path.join(config.dataDir, 'phone-bind-runtime'),
  });
  if (!materialized) {
    throw protocolError('phone binding callback state is not available', 'PHONE_BIND_EXCHANGE_STATE_MISSING');
  }
  targetStateFile = materialized.stateFile;
  const targetState = materialized.state;
  if (!phoneBindRtPendingStateAvailable(targetState)) {
    throw protocolError(
      'phone binding is not waiting for a refresh-token exchange',
      'PHONE_BIND_RT_PENDING_REQUIRED',
    );
  }
  const recovery = await reauthorizePhoneBindRefreshToken({
    config,
    account,
    phoneBindSettings,
    proxy,
    outputDir,
    runtimeStateStore,
    createSession,
  });
  const recoveryState = readJsonFile(recovery.stateFile);
  const completedState = persistPhoneBindWorkflowStage(
    targetStateFile,
    PHONE_BIND_WORKFLOW_STAGES.COMPLETED,
    {
      ...recoveryState,
      phone: targetState.phone,
      exchange_session_recovered: true,
    },
  );
  await persistDatabaseWorkflow({
    store: runtimeStateStore,
    email: account.email,
    stateFile: targetStateFile,
    workflowStage: PHONE_BIND_WORKFLOW_STAGES.COMPLETED,
  });
  return {
    status: 'completed',
    stateFile: targetStateFile,
    oauthSession: {
      ...(recovery.oauthSession || {}),
      cookies: Array.isArray(completedState.cookies) ? completedState.cookies : [],
      source: 'openai_phone_bind_exchange_fresh_authorization',
    },
  };
}

async function submitPhoneBindCode(session, code) {
  const value = String(code || '').trim();
  if (!value) {
    const error = new Error('verification code is required');
    error.code = 'PHONE_BIND_CODE_REQUIRED';
    throw error;
  }
  if (!session?.stateFile) {
    const error = new Error('phone binding protocol state is not active');
    error.code = 'PHONE_BIND_SESSION_NOT_ACTIVE';
    throw error;
  }
  let protocolFailure = null;
  try {
    await runProtocol({
      config: session.config || {},
      env: session.protocolEnv || {},
      args: [
        '--stage', 'validate',
        '--otp', value,
        '--state-file', session.stateFile,
        '--exchange-after-bind',
        '--timeout', '45',
      ],
      timeoutMs: 90000,
    });
  } catch (error) {
    protocolFailure = error;
  }
  const state = readJsonFile(session.stateFile);
  const oauthCode = String(state.oauth_code || '').trim();
  const oauthState = String(state.oauth_state || '').trim();
  const refreshToken = String(state.refresh_token || '').trim();
  const refreshTokenError = String(state.exchange_error || '').trim();
  if (oauthCode && oauthState && !refreshToken) {
    persistPhoneBindWorkflowStage(session.stateFile, PHONE_BIND_WORKFLOW_STAGES.RT_PENDING);
    await persistDatabaseWorkflow({
      store: session.runtimeStateStore,
      email: session.accountEmail,
      stateFile: session.stateFile,
      workflowStage: PHONE_BIND_WORKFLOW_STAGES.RT_PENDING,
      error: refreshTokenError ? { code: 'PHONE_BIND_REFRESH_TOKEN_MISSING', message: refreshTokenError } : null,
    });
    await session.close?.();
    return {
      status: 'rt_pending',
      stateFile: session.stateFile,
      oauthSession: {
        cookies: Array.isArray(state.cookies) ? state.cookies : [],
        workspaceId: String(state.workspace_id || ''),
        oauthCode,
        oauthState,
        refreshToken: '',
        refreshTokenError: refreshTokenError || String(protocolFailure?.message || ''),
        capturedAt: new Date().toISOString(),
        source: 'openai_phone_bind_live_rt_pending',
      },
    };
  }
  if (protocolFailure) throw protocolFailure;
  if (!oauthCode || !oauthState || !refreshToken) {
    throw protocolError(
      refreshTokenError || 'phone bind confirmation did not return callback code/state/refresh token',
      'PHONE_BIND_REFRESH_TOKEN_MISSING',
      { callbackComplete: Boolean(oauthCode && oauthState) },
    );
  }
  persistPhoneBindWorkflowStage(session.stateFile, PHONE_BIND_WORKFLOW_STAGES.COMPLETED);
  await persistDatabaseWorkflow({
    store: session.runtimeStateStore,
    email: session.accountEmail,
    stateFile: session.stateFile,
    workflowStage: PHONE_BIND_WORKFLOW_STAGES.COMPLETED,
  });
  await session.close?.();
  return {
    status: 'completed',
    stateFile: session.stateFile,
    oauthSession: {
      cookies: Array.isArray(state.cookies) ? state.cookies : [],
      workspaceId: String(state.workspace_id || ''),
      oauthCode,
      oauthState,
      refreshToken,
      refreshTokenError,
      capturedAt: new Date().toISOString(),
      source: 'openai_phone_bind_live',
    },
  };
}

async function retryPhoneBindExchange({ config, account, phoneBindSettings, runtimeStateStore, proxy = null }) {
  const materialized = await materializeDatabaseWorkflow({
    store: runtimeStateStore,
    email: account.email,
    outputDir: path.join(config.dataDir, 'phone-bind-runtime'),
  });
  if (!materialized) {
    throw protocolError(
      'phone binding callback state is not available',
      'PHONE_BIND_EXCHANGE_STATE_MISSING',
    );
  }
  const { stateFile, state } = materialized;
  if (!phoneBindRtPendingStateAvailable(state)) {
    throw protocolError(
      'phone binding callback state is not waiting for RT exchange',
      'PHONE_BIND_EXCHANGE_STATE_INCOMPLETE',
    );
  }
  const sessionId = String(state.sub2_session_id || state.session_id || '').trim();
  const oauthCode = String(state.oauth_code || '').trim();
  const oauthState = String(state.oauth_state || '').trim();
  const settings = phoneBindSettings?.getSecretConfig?.() || {};
  const protocolEnv = {
    SUB2API_BASE_URL: String(settings.sub2BaseUrl || ''),
    SUB2API_ADMIN_API_KEY: String(settings.sub2AdminApiKey || ''),
    SUB2API_PROXY_ID: String(settings.sub2ProxyId || ''),
    SUB2API_REDIRECT_URI: String(settings.sub2RedirectUri || ''),
    PHONE_BIND_PROXY: proxyUrl(proxy),
    FREEPP_BACKEND_DIR: String(config.registration?.freepp?.backendDir || ''),
  };
  await runProtocol({
    config: config || {},
    env: protocolEnv,
    args: [
      '--stage', 'exchange',
      '--state-file', stateFile,
      '--timeout', '45',
    ],
    timeoutMs: 90000,
  });
  const completedState = readJsonFile(stateFile);
  const refreshToken = String(completedState.refresh_token || '').trim();
  const refreshTokenError = String(completedState.exchange_error || '').trim();
  if (!refreshToken) {
    throw protocolError(
      refreshTokenError || 'exchange-code did not return a refresh token',
      'PHONE_BIND_REFRESH_TOKEN_MISSING',
      { callbackComplete: true },
    );
  }
  persistPhoneBindWorkflowStage(stateFile, PHONE_BIND_WORKFLOW_STAGES.COMPLETED);
  await persistDatabaseWorkflow({
    store: runtimeStateStore,
    email: account.email,
    stateFile,
    workflowStage: PHONE_BIND_WORKFLOW_STAGES.COMPLETED,
  });
  return {
    status: 'completed',
    stateFile,
    oauthSession: {
      cookies: Array.isArray(completedState.cookies) ? completedState.cookies : [],
      workspaceId: String(completedState.workspace_id || ''),
      oauthCode,
      oauthState,
      refreshToken,
      refreshTokenError,
      capturedAt: new Date().toISOString(),
      source: 'openai_phone_bind_live_exchange_retry',
    },
  };
}

async function replacePhoneBindNumber(session, phone) {
  if (!session?.stateFile) {
    throw protocolError(
      'phone binding protocol state is not active',
      'PHONE_BIND_SESSION_NOT_ACTIVE',
    );
  }
  const normalizedPhone = normalizePhone(phone);
  if (!/^\+\d{7,18}$/u.test(normalizedPhone)) {
    throw protocolError(
      'phone number must include country code, for example 56977850651',
      'PHONE_BIND_PHONE_INVALID',
    );
  }
  if (normalizedPhone === normalizePhone(session.phone)) {
    throw protocolError(
      '请输入另一个手机号后再点击换号发短信',
      'PHONE_BIND_PHONE_UNCHANGED',
    );
  }

  const timeoutSeconds = String(Math.ceil((session.config?.browser?.operationTimeoutMs || 45000) / 1000));
  const protocolArgs = [
    '--stage', 'send',
    '--phone', normalizedPhone,
    '--state-file', session.stateFile,
    '--reuse-saved-auth',
    '--skip-select',
    '--timeout', timeoutSeconds,
  ];
  if (session.protocolEnv?.PHONE_BIND_PROXY) {
    protocolArgs.push('--proxy', session.protocolEnv.PHONE_BIND_PROXY);
  }
  await runProtocol({
    config: session.config || {},
    env: session.protocolEnv || {},
    args: protocolArgs,
    timeoutMs: Math.max(
      90000,
      Number(session.config?.browser?.operationTimeoutMs || 45000) + 45000,
    ),
  });
  persistPhoneBindWorkflowStage(session.stateFile, PHONE_BIND_WORKFLOW_STAGES.OTP_REQUIRED);
  await persistDatabaseWorkflow({
    store: session.runtimeStateStore,
    email: session.accountEmail,
    stateFile: session.stateFile,
    workflowStage: PHONE_BIND_WORKFLOW_STAGES.OTP_REQUIRED,
  });
  session.phone = normalizedPhone;
  return session;
}

async function restorePhoneBindSession({
  config,
  account,
  phoneBindSettings,
  runtimeStateStore,
  proxy = null,
}) {
  if (account?.phoneBindStatus !== 'otp_required') return null;
  const materialized = await materializeDatabaseWorkflow({
    store: runtimeStateStore,
    email: account.email,
    outputDir: path.join(config.dataDir, 'phone-bind-runtime'),
  });
  if (!materialized) return null;
  const { stateFile, state, protocolDir } = materialized;
  if (
    phoneBindWorkflowStage(state) !== PHONE_BIND_WORKFLOW_STAGES.OTP_REQUIRED
      || !state.session_id
      || !state.sub2_session_id
      || !Array.isArray(state.cookies)
  ) {
    return null;
  }
  const settings = phoneBindSettings?.getSecretConfig?.() || {};
  return {
    config,
    protocolEnv: {
      SUB2API_BASE_URL: String(settings.sub2BaseUrl || ''),
      SUB2API_ADMIN_API_KEY: String(settings.sub2AdminApiKey || ''),
      SUB2API_PROXY_ID: String(settings.sub2ProxyId || ''),
      SUB2API_REDIRECT_URI: String(settings.sub2RedirectUri || ''),
      PHONE_BIND_PROXY: proxyUrl(proxy),
      FREEPP_BACKEND_DIR: String(config.registration?.freepp?.backendDir || ''),
    },
    protocol: 'openai_phone_bind_protocol',
    status: 'otp_required',
    phone: normalizePhone(state.phone || account.phoneNumber),
    accountEmail: String(account?.email || '').trim().toLowerCase(),
    protocolDir,
    stateFile,
    cookiesFile: '',
    runtimeStateStore,
    async close() {},
  };
}

module.exports = {
  chatgptSessionCookiesForFreshAuthorization,
  createPhoneBindSession,
  durableOpenAiIdentityCookies,
  hasPhoneBindOauthQualification,
  hasReusablePhoneBindAuth,
  phoneBindRtPendingStateAvailable,
  phoneBindWorkflowStage,
  recoverPhoneBindExchangeWithFreshAuthorization,
  reauthorizePhoneBindRefreshToken,
  replacePhoneBindNumber,
  replacePhoneBindNumberWithFreshAuthorization,
  retryPhoneBindExchange,
  restorePhoneBindSession,
  submitPhoneBindCode,
};
