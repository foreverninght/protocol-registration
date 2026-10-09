'use strict';

const CLOUDFLARE_CHALLENGE_RE = /challenge-platform|_cf_chl_opt|challenge-error-text|enable javascript and cookies to continue/iu;

async function pageContent(page) {
  try { return String(await page.content()); } catch { return ''; }
}

async function openChatgptHome({
  page,
  timeoutMs,
  challengeTimeoutMs = 25000,
  challengePollMs = 500,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const response = await page.goto('https://chatgpt.com/auth/login', {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs,
  });
  const status = typeof response?.status === 'function' ? response.status() : null;
  let challengeResolved = false;
  if (Number.isFinite(status) && status >= 400) {
    const initialHtml = await pageContent(page);
    if (status === 403 && CLOUDFLARE_CHALLENGE_RE.test(initialHtml)) {
      const deadline = Date.now() + Math.max(1, Number(challengeTimeoutMs) || 25000);
      while (Date.now() < deadline) {
        await sleep(Math.max(1, Number(challengePollMs) || 500));
        if (!CLOUDFLARE_CHALLENGE_RE.test(await pageContent(page))) {
          challengeResolved = true;
          break;
        }
      }
      if (!challengeResolved) {
        const error = new Error(`ChatGPT Cloudflare challenge did not clear within ${Math.round(challengeTimeoutMs / 1000)} seconds`);
        error.code = 'CHATGPT_HOME_CHALLENGE_TIMEOUT';
        error.retryableProxy = true;
        error.status = status;
        throw error;
      }
    } else {
      const error = new Error(`ChatGPT home returned HTTP ${status}`);
      error.code = 'CHATGPT_HOME_HTTP_ERROR';
      error.retryableProxy = true;
      error.status = status;
      throw error;
    }
  }
  if (!challengeResolved && Number.isFinite(status) && status >= 400) {
    const error = new Error(`ChatGPT home returned HTTP ${status}`);
    error.code = 'CHATGPT_HOME_HTTP_ERROR';
    error.retryableProxy = true;
    error.status = status;
    throw error;
  }
  return {
    step: 'home_opened',
    status: challengeResolved ? null : status,
    challengeResolved,
    url: typeof page.url === 'function' ? page.url() : null,
  };
}

module.exports = { CLOUDFLARE_CHALLENGE_RE, openChatgptHome };
