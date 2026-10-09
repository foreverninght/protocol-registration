'use strict';

class SessionFinalizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionFinalizationError';
    this.code = 'SESSION_FINALIZATION_NOT_READY';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCompletedSessionUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    return url.hostname === 'chatgpt.com' && !url.pathname.startsWith('/auth/');
  } catch {
    return false;
  }
}

async function finalizeSession({ page, timeoutMs }) {
  const deadline = Date.now() + Math.max(1000, timeoutMs || 30000);
  let lastUrl = typeof page.url === 'function' ? page.url() : null;

  while (Date.now() < deadline) {
    lastUrl = typeof page.url === 'function' ? page.url() : lastUrl;
    if (isCompletedSessionUrl(lastUrl)) {
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(5000, Math.max(500, deadline - Date.now())) }).catch(() => {});
      return {
        step: 'session_finalized',
        url: lastUrl,
      };
    }
    await delay(500);
  }

  throw new SessionFinalizationError(`profile was submitted but no completed ChatGPT session appeared; last url: ${lastUrl || 'unknown'}`);
}

async function maybeFinalizeSession({ page, timeoutMs }) {
  try {
    return await finalizeSession({ page, timeoutMs });
  } catch (error) {
    if (error?.code === 'SESSION_FINALIZATION_NOT_READY') return null;
    throw error;
  }
}

module.exports = { finalizeSession, maybeFinalizeSession, SessionFinalizationError, isCompletedSessionUrl };
