'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const { waitForVerificationCode } = require('../mailbox/mailbox-poller');

function proxyForPublicEvent(proxy) {
  if (!proxy) return null;
  return {
    id: proxy.id,
    country: proxy.country,
    host: proxy.host,
    port: proxy.port,
    poolId: proxy.poolId || null,
  };
}

function proxyForBridge(proxy) {
  if (!proxy) return null;
  return {
    raw: proxy.raw || '',
    host: proxy.host,
    port: proxy.port,
    username: proxy.username || '',
    password: proxy.password || '',
  };
}

function splitLines(buffer, chunk) {
  const combined = buffer + chunk;
  const lines = combined.split(/\r?\n/u);
  return { lines: lines.slice(0, -1), rest: lines.at(-1) || '' };
}

function terminalFailureCodeFromText(value) {
  const text = String(value || '');
  if (/user_already_exists|already exists for this email address|\bALREADY_REGISTERED\b|\u90ae\u7bb1\u5df2\u6ce8\u518c/iu.test(text)) {
    return 'FREEPP_EMAIL_ALREADY_REGISTERED';
  }
  if (/ICMAIL_PUBLIC_HTTP_ERROR/u.test(text)) return 'ICMAIL_PUBLIC_HTTP_ERROR';
  if (/ICLOUD_SHEEX_HTTP_ERROR/u.test(text)) return 'ICLOUD_SHEEX_HTTP_ERROR';
  if (/MAILBOX_PROVIDER_ERROR/u.test(text)) return 'MAILBOX_PROVIDER_ERROR';
  if (/MAILBOX_POLL_FAILED/u.test(text)) return 'MAILBOX_POLL_FAILED';
  if (/MAILBOX_CODE_TIMEOUT/u.test(text)) return 'MAILBOX_CODE_TIMEOUT';
  if (/FREEPP_EGRESS_CHANGED/u.test(text)) return 'FREEPP_EGRESS_CHANGED';
  if (/FREEPP_OAUTH_COOKIE_MISSING/u.test(text)) return 'FREEPP_OAUTH_COOKIE_MISSING';
  if (/CREDENTIAL_REPAIR_UNKNOWN_MFA/u.test(text)) return 'CREDENTIAL_REPAIR_UNKNOWN_MFA';
  if (/CREDENTIAL_REPAIR_MAILBOX_MISMATCH/u.test(text)) return 'CREDENTIAL_REPAIR_MAILBOX_MISMATCH';
  return '';
}

function terminalFailureRetryableProxy(code) {
  return !new Set([
    'FREEPP_EMAIL_ALREADY_REGISTERED',
    'ICMAIL_PUBLIC_HTTP_ERROR',
    'ICLOUD_SHEEX_HTTP_ERROR',
    'MAILBOX_PROVIDER_ERROR',
    'MAILBOX_POLL_FAILED',
    'MAILBOX_CODE_TIMEOUT',
    'FREEPP_OAUTH_COOKIE_MISSING',
    'CREDENTIAL_REPAIR_UNKNOWN_MFA',
    'CREDENTIAL_REPAIR_MAILBOX_MISMATCH',
  ]).has(code);
}

function credentialRepairForBridge(account = {}, task = {}) {
  const tokens = account.tokens && typeof account.tokens === 'object' ? account.tokens : {};
  const sessionContext = account.sessionContext && typeof account.sessionContext === 'object'
    ? account.sessionContext
    : {};
  const cookies = [
    ...(Array.isArray(account.oauthSession?.cookies) ? account.oauthSession.cookies : []),
    ...(Array.isArray(account.session?.cookies) ? account.session.cookies : []),
  ];
  const passwordStatus = String(account.passwordStatus || '').trim().toLowerCase();
  const totpStatus = String(account.totpStatus || '').trim().toLowerCase();
  return {
    email: String(account.loginEmail || account.email || task.email || '').trim(),
    mailbox_email: String(account.email || task.email || '').trim(),
    password: String(account.password ?? task.registrationPassword ?? ''),
    password_status: passwordStatus || 'unknown',
    totp_status: totpStatus || 'unknown',
    setup_password: passwordStatus !== 'has_password',
    setup_totp: totpStatus !== 'enabled',
    access_token: String(tokens.accessToken || tokens.access_token || '').trim(),
    session_token: String(tokens.sessionToken || tokens.session_token || '').trim(),
    token_json: tokens,
    session_context: sessionContext,
    cookies,
    totp: account.totpSecret || account.totpActiveFactorId
      ? {
        secret: String(account.totpSecret || ''),
        active_factor_id: String(account.totpActiveFactorId || ''),
        enrollment_session_id: String(account.totpEnrollmentSessionId || ''),
        activated: typeof account.totpActivated === 'boolean' ? account.totpActivated : null,
        verified: typeof account.totpVerified === 'boolean' ? account.totpVerified : null,
      }
      : null,
  };
}

function freeppConfigForBranch(config, entryBranch = 'freepp') {
  const branch = String(entryBranch || 'freepp').trim().toLowerCase();
  if (branch !== 'freepp') {
    throw Object.assign(new Error(`unsupported registration implementation: ${branch}`), {
      code: 'REGISTRATION_ENTRY_BRANCH_UNSUPPORTED', status: 400, retryableProxy: false,
    });
  }
  return config.registration?.freepp || {};
}

function cancellationError(signal) {
  return signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('freepp sidecar cancelled'), { code: 'FREEPP_SIDECAR_CANCELLED' });
}

async function captureMailboxBaseline({ provider, email, signal } = {}) {
  if (!provider || typeof provider.snapshotMessages !== 'function') {
    const error = new Error('mail.com provider must support a complete pre-registration message snapshot');
    error.code = 'MAILBOX_BASELINE_SNAPSHOT_REQUIRED';
    error.retryableProxy = false;
    throw error;
  }
  const seenIds = new Set();
  const seenCodes = new Set();
  let messages;
  try {
    messages = await provider.snapshotMessages({ email, signal });
  } catch (error) {
    error.retryableProxy = false;
    throw error;
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    const id = String(message?.id || '').trim();
    const code = String(message?.text || '').trim();
    if (id) seenIds.add(id);
    if (code) seenCodes.add(code);
  }
  return { seenIds, seenCodes };
}

async function runFreeppBridge({
  config,
  task,
  proxy,
  mailboxProvider,
  mailboxSource,
  entryBranch = 'freepp',
  phoneBindSettings = null,
  changeEmailSettings = null,
  credentialRepair = null,
  update,
  startedAt = Date.now(),
  signal,
}) {
  if (signal?.aborted) throw cancellationError(signal);
  const mailboxMatchesLogin = !credentialRepair || String(credentialRepair.mailbox_email || task.email).toLowerCase() === String(credentialRepair.email || task.email).toLowerCase();
  const baseline = mailboxSource === 'mail_com_split' && mailboxMatchesLogin
    ? await captureMailboxBaseline({ provider: mailboxProvider, email: task.email, signal })
    : { seenIds: new Set(), seenCodes: new Set() };
  if (signal?.aborted) throw cancellationError(signal);
  return new Promise((resolve, reject) => {
    const freeppConfig = freeppConfigForBranch(config, entryBranch);
    const python = freeppConfig.python || 'python';
    const script = path.resolve(__dirname, '..', '..', 'tools', 'freepp_register_bridge.py');
    const registrationExtras = changeEmailSettings?.getSecretConfig?.() || {};
    const postRegistrationDelaySeconds = Math.max(0, Math.min(600, Math.trunc(Number(registrationExtras.postRegistrationDelaySeconds) || 0)));
    const bridgeConfig = {
      freepp_backend_dir: freeppConfig.backendDir,
      sentinel_mode: credentialRepair ? 'pure' : freeppConfig.sentinelMode || 'pure',
      email: task.email,
      password: task.registrationPassword,
      mailbox_source: mailboxSource,
      proxy: proxyForBridge(proxy),
      setup_password: credentialRepair
        ? credentialRepair.setup_password === true
        : registrationExtras.setupPassword === true,
      setup_totp: credentialRepair
        ? credentialRepair.setup_totp === true
        : registrationExtras.setupTotp2fa === true,
      ...(credentialRepair ? { credential_repair: credentialRepair } : {}),
      validate_oauth_session: registrationExtras.validateOauthSession === true,
      auto_check_eligibility: registrationExtras.autoCheckEligibility === true,
      post_registration_delay_seconds: postRegistrationDelaySeconds,
      mailbox_timeout_sec: Math.ceil(config.mailbox.pollTimeoutMs / 1000),
      phone_bind_probe: {
        ...(phoneBindSettings?.getSecretConfig?.() || {}),
        enabled: registrationExtras.phoneBindProbeEnabled === true,
      },
      change_email: registrationExtras,
    };
    const child = spawn(python, [script, '--config-stdin'], {
      cwd: path.dirname(script),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        OPENAI_SENTINEL_MODE: credentialRepair
          ? 'pure'
          : freeppConfig.sentinelMode || process.env.OPENAI_SENTINEL_MODE || 'pure',
      },
    });

    let settled = false;
    const pollController = new AbortController();
    const originalUpdate = update;
    update = (event) => { if (!settled) originalUpdate(event); };
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let result = null;
    let terminalFailureCode = '';
    let terminalFailureMessage = '';
    const servedMailIds = new Set(baseline.seenIds);
    const servedCodes = new Set(baseline.seenCodes);
    const effectiveTimeoutMs = Number(freeppConfig.timeoutMs) + (postRegistrationDelaySeconds * 1000);
    const idleTimeoutMs = Math.max(30000, Math.min(180000, Number(freeppConfig.idleTimeoutMs || process.env.FREEPP_SIDECAR_IDLE_TIMEOUT_MS || 180000)));
    let idleTimer = null;
    const killSidecar = (code, message) => {
      if (settled) return;
      child.kill('SIGTERM');
      const error = new Error(message);
      error.code = code;
      finish(reject, error);
    };
    const refreshIdleTimer = (stage = 'sidecar') => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        update({
          type: 'registration.freepp_sidecar_idle_timeout',
          status: 'failed',
          step: 'freepp_sidecar_idle_timeout',
          idleTimeoutMs,
          stage,
          error: {
            code: 'FREEPP_SIDECAR_IDLE_TIMEOUT',
            message: `freepp sidecar produced no progress for ${idleTimeoutMs}ms`,
          },
        });
        killSidecar('FREEPP_SIDECAR_IDLE_TIMEOUT', `freepp sidecar produced no progress for ${idleTimeoutMs}ms`);
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    const timer = setTimeout(() => {
      killSidecar('FREEPP_SIDECAR_TIMEOUT', `freepp sidecar timed out after ${effectiveTimeoutMs}ms`);
    }, effectiveTimeoutMs);
    refreshIdleTimer('started');

    child.stdin.on('error', () => {
      // The Python sidecar may exit while Node is still flushing an RPC response.
      // Treat that as sidecar completion/failure, not as a process-level crash.
    });

    const respond = (id, payload) => {
      if (settled || !id || !child.stdin.writable || child.stdin.destroyed || child.stdin.writableEnded) return;
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      } catch {
        // Ignore late responses after sidecar stdin is gone.
      }
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      pollController.abort(value instanceof Error ? value : undefined);
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      fn(value);
    };

    const onAbort = () => {
      if (settled) return;
      child.kill('SIGTERM');
      finish(reject, cancellationError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const handleMessage = async (message) => {
      if (settled) return;
      refreshIdleTimer(message.type || 'message');
      if (message.type === 'event') {
        update({
          type: `registration.${message.step || 'freepp_event'}`,
          status: 'running',
          step: message.step || 'freepp_event',
          result: message.payload || {},
        });
        respond(message.id, { ok: true });
        return;
      }
      if (message.type === 'fetch_code') {
        if (!mailboxMatchesLogin) {
          respond(message.id, { ok: false, error_code: 'CREDENTIAL_REPAIR_MAILBOX_MISMATCH', error: 'CREDENTIAL_REPAIR_MAILBOX_MISMATCH: no mailbox route is configured for the changed login email' });
          return;
        }
        if (!mailboxProvider) {
          respond(message.id, { ok: false, error: 'no mailbox provider configured for freepp task' });
          return;
        }
        try {
          const requestSeenIds = Array.isArray(message.seen_ids) ? message.seen_ids : [];
          const requestSeenCodes = Array.isArray(message.seen_codes) ? message.seen_codes : [];
          const rawAfterMs = message.after_ms;
          const parsedAfterMs = Number(rawAfterMs);
          const hasExplicitAfterMs = rawAfterMs !== null
            && rawAfterMs !== undefined
            && rawAfterMs !== ''
            && Number.isFinite(parsedAfterMs)
            && parsedAfterMs > 0;
          const requestedAfter = hasExplicitAfterMs ? parsedAfterMs : startedAt;
          const purpose = String(message.purpose || 'registration_otp').trim().toLowerCase();
          // mail.com is filtered by the complete pre-request ID/code baseline.
          // Its displayed timestamps are not used because mailbox timezones can differ.
          const effectiveAfter = mailboxSource === 'mail_com_split' ? 0 : requestedAfter;
          const codeResult = await waitForVerificationCode({
            provider: mailboxProvider,
            signal: pollController.signal,
            email: message.email || task.email,
            after: effectiveAfter,
            seenIds: [...servedMailIds, ...requestSeenIds],
            seenCodes: [...servedCodes, ...requestSeenCodes],
            timeoutMs: Math.max(1000, Number(message.timeout_sec || 0) * 1000 || config.mailbox.pollTimeoutMs),
            intervalMs: config.mailbox.pollIntervalMs,
            onEvent: (event) => update({
              ...event,
              mailboxSource,
              purpose,
              status: 'waiting_for_otp',
              step: event.type === 'mailbox.code_found' ? 'otp_code_available' : 'mailbox_polling',
            }),
          });
          if (codeResult.mail?.id) servedMailIds.add(String(codeResult.mail.id));
          if (codeResult.code) servedCodes.add(String(codeResult.code));
          respond(message.id, {
            ok: true,
            code: codeResult.code,
            mail: {
              id: codeResult.mail?.id || null,
              subject: codeResult.mail?.subject || '',
              sender: codeResult.mail?.sender || '',
              receivedAt: codeResult.mail?.receivedAt || null,
            },
          });
        } catch (error) {
          respond(message.id, { ok: false, error_code: error?.code || 'MAILBOX_POLL_FAILED', error: `${error?.code || 'MAILBOX_POLL_FAILED'}: ${String(error?.message || error)}` });
        }
        return;
      }
      if (message.type === 'result') {
        result = message;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      refreshIdleTimer('stdout');
      const split = splitLines(stdoutBuffer, chunk);
      stdoutBuffer = split.rest;
      for (const line of split.lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          update({ type: 'registration.freepp_sidecar_stdout', status: 'running', step: 'freepp_sidecar_stdout', message: line.slice(0, 500) });
          continue;
        }
        handleMessage(message).catch((error) => {
          if (message?.id) respond(message.id, { ok: false, error: String(error?.message || error) });
        });
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      refreshIdleTimer('stderr');
      const split = splitLines(stderrBuffer, chunk);
      stderrBuffer = split.rest;
      for (const line of split.lines) {
        if (line.trim()) {
          const detectedCode = terminalFailureCodeFromText(line);
          if (detectedCode) {
            terminalFailureCode = detectedCode;
            terminalFailureMessage = line.trim().slice(0, 800);
          }
          update({ type: 'registration.freepp_log', status: 'running', step: 'freepp_log', message: line.slice(0, 800) });
        }
      }
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (stderrBuffer.trim()) {
        const trailingLog = stderrBuffer.trim().slice(0, 800);
        const detectedCode = terminalFailureCodeFromText(trailingLog);
        if (detectedCode) {
          terminalFailureCode = detectedCode;
          terminalFailureMessage = trailingLog;
        }
        update({ type: 'registration.freepp_log', status: 'running', step: 'freepp_log', message: trailingLog });
      }
      if (stdoutBuffer.trim()) {
        try {
          const message = JSON.parse(stdoutBuffer);
          if (message.type === 'result') result = message;
        } catch {}
      }
      if (result?.ok) return finish(resolve, result);
      const resultMessage = result?.error || `freepp sidecar exited with code ${code}`;
      const detectedCode = terminalFailureCodeFromText(resultMessage) || terminalFailureCode;
      const message = detectedCode && !terminalFailureCodeFromText(resultMessage)
        ? `${detectedCode}: ${resultMessage}; evidence=${terminalFailureMessage}`
        : resultMessage;
      const error = new Error(message);
      error.code = detectedCode || 'FREEPP_REGISTRATION_FAILED';
      error.exitCode = code;
      error.retryableProxy = terminalFailureRetryableProxy(error.code);
      return finish(reject, error);
    });
    if (!settled) {
      try {
        child.stdin.write(`${JSON.stringify({ type: 'init', config: bridgeConfig })}\n`);
      } catch (error) {
        child.kill('SIGTERM');
        finish(reject, error);
      }
    }
  });
}

async function runFreeppRegistration({
  config,
  task,
  proxy,
  mailbox,
  entryBranch = 'freepp',
  phoneBindSettings = null,
  changeEmailSettings = null,
  update,
  startedAt = Date.now(),
  signal,
}) {
  if (signal?.aborted) throw cancellationError(signal);
  const freeppConfig = freeppConfigForBranch(config, entryBranch);
  update({
    type: 'registration.freepp_sidecar_launching',
    status: 'running',
    step: 'freepp_sidecar_launching',
    proxy: proxyForPublicEvent(proxy),
    entryBranch,
    backendDir: freeppConfig.backendDir || '',
    sentinelMode: freeppConfig.sentinelMode || 'pure',
  });
  const result = await runFreeppBridge({
    config,
    task,
    proxy,
    mailboxProvider: mailbox.provider,
    mailboxSource: mailbox.source,
    entryBranch,
    phoneBindSettings,
    changeEmailSettings,
    update,
    startedAt,
    signal,
  });
  const totp = result.totp && typeof result.totp === 'object' ? result.totp : null;
  return {
    email: result.email || task.email,
    loginEmail: result.login_email || result.email || task.email,
    emailChange: result.email_change && typeof result.email_change === 'object' ? result.email_change : null,
    emailChangeError: result.email_change_error && typeof result.email_change_error === 'object' ? result.email_change_error : null,
    password: result.password || task.registrationPassword,
    passwordStatus: result.password_status === 'has_password' ? 'has_password' : 'no_password',
    passwordError: result.password_error && typeof result.password_error === 'object'
      ? result.password_error
      : null,
    passwordSessionRefreshError: result.password_session_refresh_error || null,
    accessToken: result.access_token || result.token_json?.accessToken || result.token_json?.access_token || '',
    sessionToken: result.session_token || result.token_json?.sessionToken || result.token_json?.session_token || '',
    refreshToken: result.token_json?.refresh_token || result.token_json?.refreshToken || '',
    tokenJson: result.token_json || {},
    sessionContext: result.session_context && typeof result.session_context === 'object' ? result.session_context : {},
    oauthSession: result.oauth_session && typeof result.oauth_session === 'object' ? result.oauth_session : null,
    phoneBindProbe: result.phone_bind_probe && typeof result.phone_bind_probe === 'object' && Object.keys(result.phone_bind_probe).length ? result.phone_bind_probe : null,
    totpSecret: totp?.secret || '',
    totpActivated: typeof totp?.activated === 'boolean' ? totp.activated : null,
    totpVerified: typeof totp?.verified === 'boolean' ? totp.verified : null,
    totpActiveFactorId: totp?.active_factor_id || '',
    totpEnrollmentSessionId: totp?.enrollment_session_id || '',
    totpError: result.totp_error && typeof result.totp_error === 'object' ? result.totp_error : null,
    eligibilityCheck: result.eligibility_check && typeof result.eligibility_check === 'object'
      ? result.eligibility_check
      : null,
    eligibilityError: result.eligibility_error && typeof result.eligibility_error === 'object'
      ? result.eligibility_error
      : null,
    finalAtValidation: result.final_at_validation && typeof result.final_at_validation === 'object'
      ? result.final_at_validation
      : null,
    completionError: result.completion_error && typeof result.completion_error === 'object' ? result.completion_error : null,
    completedAt: result.completed_at || Date.now(),
  };
}

async function runFreeppCredentialRepair({
  config,
  task,
  proxy,
  mailbox,
  account,
  entryBranch = 'freepp',
  update,
  startedAt = Date.now(),
  signal,
}) {
  if (signal?.aborted) throw cancellationError(signal);
  const freeppConfig = freeppConfigForBranch(config, entryBranch);
  const credentialRepair = credentialRepairForBridge(account, task);
  update({
    type: 'credential_repair.freepp_sidecar_launching',
    status: 'running',
    step: 'freepp_sidecar_launching',
    proxy: proxyForPublicEvent(proxy),
    entryBranch,
    backendDir: freeppConfig.backendDir || '',
    sentinelMode: 'pure',
  });
  const result = await runFreeppBridge({
    config,
    task: { ...task, email: credentialRepair.email, registrationPassword: credentialRepair.password },
    proxy,
    mailboxProvider: mailbox?.provider || null,
    mailboxSource: mailbox?.source || task.mailboxSource || '',
    entryBranch,
    credentialRepair,
    update,
    startedAt,
    signal,
  });
  const totp = result.totp && typeof result.totp === 'object' ? result.totp : null;
  return {
    email: account.email || task.email || credentialRepair.email,
    loginEmail: result.email || credentialRepair.email,
    password: result.password || credentialRepair.password,
    passwordStatus: result.password_status === 'has_password' ? 'has_password' : 'no_password',
    passwordError: result.password_error && typeof result.password_error === 'object' ? result.password_error : null,
    passwordSessionRefreshError: result.password_session_refresh_error || null,
    accessToken: result.access_token || result.token_json?.accessToken || result.token_json?.access_token || '',
    sessionToken: result.session_token || result.token_json?.sessionToken || result.token_json?.session_token || '',
    refreshToken: result.token_json?.refresh_token || result.token_json?.refreshToken || '',
    tokenJson: result.token_json || {},
    sessionContext: result.session_context && typeof result.session_context === 'object' ? result.session_context : {},
    oauthSession: result.oauth_session && typeof result.oauth_session === 'object' ? result.oauth_session : null,
    totpSecret: totp?.secret || '',
    totpActivated: typeof totp?.activated === 'boolean' ? totp.activated : null,
    totpVerified: typeof totp?.verified === 'boolean' ? totp.verified : null,
    totpActiveFactorId: totp?.active_factor_id || '',
    totpEnrollmentSessionId: totp?.enrollment_session_id || '',
    totpError: result.totp_error && typeof result.totp_error === 'object' ? result.totp_error : null,
    finalAtValidation: result.final_at_validation && typeof result.final_at_validation === 'object'
      ? result.final_at_validation
      : null,
    completionError: result.completion_error && typeof result.completion_error === 'object' ? result.completion_error : null,
    completedAt: result.completed_at || Date.now(),
  };
}

module.exports = {
  runFreeppRegistration,
  runFreeppCredentialRepair,
  runFreeppBridge,
  credentialRepairForBridge,
  terminalFailureCodeFromText,
  terminalFailureRetryableProxy,
  freeppConfigForBranch,
  captureMailboxBaseline,
};
