'use strict';

const { selectLatestVerificationCodeMail } = require('./mail-code-parser');

class MailboxPollTimeoutError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MailboxPollTimeoutError';
    this.code = 'MAILBOX_CODE_TIMEOUT';
    this.details = details;
  }
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  const normalized = Number.isFinite(number) ? Math.trunc(number) : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function baselineWithTolerance(after, toleranceMs) {
  if (!after) return after;
  const tolerance = clampNumber(toleranceMs, 10000, 0, 30000);
  if (typeof after === 'number' && Number.isFinite(after)) {
    const milliseconds = after > 100000000000 ? after : after * 1000;
    return Math.max(0, milliseconds - tolerance);
  }
  const parsed = Date.parse(String(after));
  return Number.isFinite(parsed) ? Math.max(0, parsed - tolerance) : after;
}

function redactedMailSummary(mail) {
  if (!mail) return null;
  return {
    id: mail.id || null,
    receivedAt: mail.receivedAt || null,
    subject: mail.subject || '',
    sender: mail.sender || '',
  };
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('aborted'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function emit(onEvent, event) {
  try {
    if (typeof onEvent === 'function') onEvent(event);
  } catch {
    // Observability must not change mailbox behavior.
  }
}

function isRetryableMailboxProviderError(error) {
  const status = Number(error?.status);
  if (Number.isFinite(status)) return status >= 500 && status < 600;
  const code = String(error?.code || '');
  return /TIMEOUT|NETWORK|ECONN|ETIMEDOUT|FETCH|SOCKET/i.test(code)
      || /timeout|network|socket|fetch failed|aborted/i.test(String(error?.message || error || ''));
}

async function waitForVerificationCode(options) {
  const {
    provider,
    email,
    after,
    signal,
    onEvent,
  } = options || {};
  if (!provider || typeof provider.listMessages !== 'function') {
    throw new TypeError('mailbox provider must expose listMessages({ email, signal })');
  }
  if (!email || typeof email !== 'string') {
    throw new TypeError('email is required');
  }

  const timeoutMs = clampNumber(options.timeoutMs, 120000, 1000, 15 * 60 * 1000);
  const intervalMs = clampNumber(options.intervalMs, 3000, 250, 60000);
  const pollAfter = baselineWithTolerance(after, options.afterToleranceMs);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastCount = 0;
  let lastReason = 'not_polled';

  emit(onEvent, {
    type: 'mailbox.poll_started',
    email,
    after,
    pollAfter,
    timeoutMs,
    intervalMs,
  });

  while (Date.now() <= deadline) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    attempts += 1;

    let messages;
    try {
      messages = await provider.listMessages({
        email,
        signal,
        after: pollAfter,
        seenIds: options.seenIds || options.excludeIds || options.excludedIds || [],
        seenCodes: options.seenCodes || options.excludeCodes || options.excludedCodes || [],
      });
    } catch (error) {
      emit(onEvent, {
        type: 'mailbox.poll_failed',
        email,
        attempt: attempts,
        error: { code: error?.code || 'MAILBOX_PROVIDER_ERROR', message: String(error?.message || error) },
      });
      lastCount = 0;
      lastReason = error?.code || 'mailbox_provider_error';
      if (!isRetryableMailboxProviderError(error)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(intervalMs, remaining), signal);
      continue;
    }

    lastCount = Array.isArray(messages) ? messages.length : 0;
    const selected = selectLatestVerificationCodeMail(messages, {
      after: pollAfter,
      seenIds: options.seenIds || options.excludeIds || options.excludedIds || [],
      seenCodes: options.seenCodes || options.excludeCodes || options.excludedCodes || [],
    });
    lastReason = selected.reason;
    emit(onEvent, {
      type: 'mailbox.poll_checked',
      email,
      attempt: attempts,
      messageCount: lastCount,
      found: selected.found,
      reason: selected.reason,
      mail: redactedMailSummary(selected.mail),
    });

    if (selected.found) {
      emit(onEvent, {
        type: 'mailbox.code_found',
        email,
        attempt: attempts,
        elapsedMs: Date.now() - startedAt,
        mail: redactedMailSummary(selected.mail),
      });
      return {
        code: selected.code,
        mail: selected.mail,
        attempts,
        elapsedMs: Date.now() - startedAt,
      };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(intervalMs, remaining), signal);
  }

  throw new MailboxPollTimeoutError('no verification code mail arrived after task baseline', {
    email,
    after,
    attempts,
    timeoutMs,
    lastCount,
    lastReason,
  });
}

async function waitForVerificationCodeTwoPhase(options) {
  const {
    provider,
    email,
    after,
    timeoutMs,
    intervalMs,
    phase1TimeoutMs,
    phase2TimeoutMs,
    resend,
    onEvent,
    signal,
  } = options || {};
  const firstTimeout = clampNumber(phase1TimeoutMs, clampNumber(timeoutMs, 120000, 1000, 15 * 60 * 1000), 1000, 15 * 60 * 1000);
  const secondTimeout = clampNumber(phase2TimeoutMs, clampNumber(timeoutMs, 120000, 1000, 15 * 60 * 1000), 1000, 15 * 60 * 1000);
  try {
    return await waitForVerificationCode({
      provider,
      email,
      after,
      timeoutMs: firstTimeout,
      intervalMs,
      onEvent,
      signal,
    });
  } catch (error) {
    if (!(error instanceof MailboxPollTimeoutError)) throw error;
    emit(onEvent, {
      type: 'mailbox.otp_phase1_timeout',
      email,
      timeoutMs: firstTimeout,
      error: {
        code: error.code || 'MAILBOX_CODE_TIMEOUT',
        message: String(error.message || error),
      },
    });
    if (typeof resend !== 'function') throw error;

    // A fast mailbox can receive the OTP before the resend request returns.
    // Capture the baseline before triggering the resend so that mail is not
    // discarded as older than the request.
    const resendAt = Date.now();
    const resendResult = await resend().catch((resendError) => {
      emit(onEvent, {
        type: 'mailbox.otp_resend_failed',
        email,
        error: {
          code: resendError?.code || 'MAILBOX_OTP_RESEND_FAILED',
          message: String(resendError?.message || resendError),
        },
      });
      return null;
    });
    emit(onEvent, {
      type: 'mailbox.otp_resend_triggered',
      email,
      resendAt,
      result: resendResult || null,
    });

    return waitForVerificationCode({
      provider,
      email,
      after: resendAt,
      timeoutMs: secondTimeout,
      intervalMs,
      onEvent,
      signal,
    });
  }
}

async function waitForVerificationCodeWithResends(options) {
  const {
    provider,
    email,
    intervalMs,
    resend,
    onEvent,
    signal,
  } = options || {};
  const maxAttempts = clampNumber(options?.maxAttempts, 3, 1, 5);
  const firstTimeout = clampNumber(
    options?.phase1TimeoutMs,
    clampNumber(options?.timeoutMs, 120000, 1000, 15 * 60 * 1000),
    1000,
    15 * 60 * 1000,
  );
  const retryTimeout = clampNumber(
    options?.phase2TimeoutMs,
    firstTimeout,
    1000,
    15 * 60 * 1000,
  );
  let baseline = options?.after;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await waitForVerificationCode({
        provider,
        email,
        after: baseline,
        timeoutMs: attempt === 1 ? firstTimeout : retryTimeout,
        intervalMs,
        onEvent,
        signal,
      });
    } catch (error) {
      if (!(error instanceof MailboxPollTimeoutError)) throw error;
      lastError = error;
      emit(onEvent, {
        type: 'mailbox.otp_attempt_timeout',
        email,
        attempt,
        maxAttempts,
        error: { code: error.code, message: String(error.message || error) },
      });
      if (attempt >= maxAttempts || typeof resend !== 'function') break;
      const resendAt = Date.now();
      const resendResult = await resend({ attempt: attempt + 1 }).catch((resendError) => {
        emit(onEvent, {
          type: 'mailbox.otp_resend_failed',
          email,
          attempt: attempt + 1,
          error: {
            code: resendError?.code || 'MAILBOX_OTP_RESEND_FAILED',
            message: String(resendError?.message || resendError),
          },
        });
        return null;
      });
      emit(onEvent, {
        type: 'mailbox.otp_resend_triggered',
        email,
        attempt: attempt + 1,
        resendAt,
        result: resendResult || null,
      });
      baseline = resendAt;
    }
  }
  throw lastError || new MailboxPollTimeoutError('no verification code mail arrived after task baseline', {
    email,
    after: baseline,
  });
}

module.exports = {
  waitForVerificationCode,
  waitForVerificationCodeTwoPhase,
  waitForVerificationCodeWithResends,
  MailboxPollTimeoutError,
  redactedMailSummary,
  isRetryableMailboxProviderError,
};
