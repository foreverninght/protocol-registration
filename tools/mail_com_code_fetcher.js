#!/usr/bin/env node
'use strict';

const readline = require('node:readline/promises');
const fs = require('node:fs');
const path = require('node:path');
const { stdin: input, stdout: output } = require('node:process');
const { extractVerificationCodeFromMail } = require('../src/mailbox/mail-code-parser');

const DEFAULT_TIMEOUT_MS = 60000;
const MAILCOM_OAUTH_BASIC = `Basic ${Buffer.from(
  'mailcom_mailcompose_passport_live:*******',
  'utf8',
).toString('base64')}`;

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    if (['headed', 'headless', 'json', 'keep-open'].includes(key)) {
      args[key] = true;
      continue;
    }
    args[key] = argv[index + 1];
    index += 1;
  }
  return args;
}

async function ask(question) {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function askHidden(question) {
  if (!input.isTTY) return ask(question);
  output.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  let value = '';
  return new Promise((resolve) => {
    const onData = (char) => {
      if (char === '\r' || char === '\n' || char === '\u0004') {
        input.setRawMode(false);
        input.pause();
        input.off('data', onData);
        output.write('\n');
        resolve(value);
        return;
      }
      if (char === '\u0003') process.exit(130);
      if (char === '\b' || char === '\u007f') {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };
    input.on('data', onData);
  });
}

function tryRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

function proxyFromUrl(raw) {
  if (!raw) return undefined;
  const url = new URL(raw);
  return {
    server: `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
  };
}

function pickBrowserLibrary() {
  const patchright = tryRequire('patchright');
  if (patchright?.chromium) return { name: 'patchright', chromium: patchright.chromium };
  const playwrightCore = tryRequire('playwright-core');
  if (playwrightCore?.chromium) return { name: 'playwright-core', chromium: playwrightCore.chromium };
  throw new Error('Cannot find patchright or playwright-core in this project.');
}

async function launchBrowser(args) {
  const { name, chromium } = pickBrowserLibrary();
  const headless = args.headed ? false : true;
  const launchBase = {
    headless,
    proxy: proxyFromUrl(args.proxy),
    args: [
      '--disable-save-password-bubble',
      '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  };
  const launchAttempts = [];
  if (args.executable) launchAttempts.push({ ...launchBase, executablePath: args.executable });
  launchAttempts.push({ ...launchBase, channel: 'chrome' });
  launchAttempts.push({ ...launchBase, channel: 'msedge' });
  launchAttempts.push(launchBase);

  let lastError = null;
  for (const options of launchAttempts) {
    try {
      const browser = await chromium.launch(options);
      return { browser, library: name };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function candidateTextsFromJson(value, output = []) {
  if (!value || output.length > 200) return output;
  if (typeof value === 'string') {
    if (/\d{6}|chatgpt|openai|verification|验证码|code/i.test(value)) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    value.slice(0, 100).forEach((item) => candidateTextsFromJson(item, output));
    return output;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/subject|from|sender|text|body|preview|snippet|content|html|mail/i.test(key)) {
        candidateTextsFromJson(child, output);
      } else if (typeof child === 'object') {
        candidateTextsFromJson(child, output);
      }
    }
  }
  return output;
}

function mailsFromMailListJson(json) {
  const elements = Array.isArray(json?.mailListElements) ? json.mailListElements : [];
  return elements
    .filter((entry) => entry?.type === 'mail' && entry.rawData)
    .map((entry) => {
      const header = entry.rawData.mailHeader || {};
      return {
        id: entry.rawData.attribute?.mailIdentifier || entry.rawData.mailURI || null,
        uri: entry.rawData.mailURI || null,
        removalUri: entry.rawData.removalUri || null,
        subject: header.subject || '',
        sender: header.from || '',
        to: Array.isArray(header.to) ? header.to : [],
        cc: Array.isArray(header.cc) ? header.cc : [],
        bcc: Array.isArray(header.bcc) ? header.bcc : [],
        text: [
          header.subject || '',
          header.from || '',
          entry.rawData.preview || '',
          entry.rawData.snippet || '',
        ].filter(Boolean).join('\n'),
        receivedAt: header.date ? new Date(header.date).toISOString() : null,
      };
    });
}

function extractCodeFromText(text, source = 'page') {
  return extractVerificationCodeFromMail({
    id: source,
    subject: '',
    sender: '',
    text,
    receivedAt: new Date().toISOString(),
  }, { minScore: 25 });
}

function isChatGptOpenAiMail(mail) {
  const haystack = [mail?.sender, mail?.subject].filter(Boolean).join(' ');
  return /chatgpt|openai/i.test(haystack);
}

function isExcludedMail(mail, options = {}) {
  const excludedIds = new Set(Array.isArray(options.excludeMailIds) ? options.excludeMailIds.filter(Boolean).map(String) : []);
  const excludedCodes = new Set(Array.isArray(options.excludeCodes) ? options.excludeCodes.filter(Boolean).map(String) : []);
  if (mail?.id && excludedIds.has(String(mail.id))) return true;
  if (mail?.code && excludedCodes.has(String(mail.code))) return true;
  return false;
}

function mailLogEntry(mail) {
  return {
    id: mail?.id || null,
    sender: mail?.sender || '',
    subject: mail?.subject || '',
    receivedAt: mail?.receivedAt || null,
    target: isChatGptOpenAiMail(mail),
  };
}

function mailIdFromMailBodyUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const match = url.pathname.match(/\/Mail\/([^/]+)\/Body\/html/i);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function webmailFrameForPage(page) {
  return page.frames().find((frame) => /^https:\/\/webmailer\.mail\.com(?:\/|$)/i.test(frame.url()))
    || page.frames().find((frame) => /webmailer\.mail\.com/i.test(frame.url()))
    || page.mainFrame();
}

function visibleTextLocator(page, pattern) {
  return page.locator(`text=${pattern}`).first();
}

async function directFetchInbox(page, folderTypeOrId = 'INBOX', offset = 0, amount = 50) {
  const noCache = `a-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  let sid = '';
  try {
    sid = new URL(page.url()).searchParams.get('sid') || '';
  } catch {}
  const webmailFrame = webmailFrameForPage(page);
  let accessToken = '';
  if (sid) {
    const tokenResult = await webmailFrame.evaluate(async ({ sid, basicAuthorization }) => {
      const response = await fetch(
        `https://oauthbridge.navigator-lxa.mail.com/navigator/oauth2/token?sid=${encodeURIComponent(sid)}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            accept: '*/*',
            'content-type': 'application/x-www-form-urlencoded',
            'cache-control': 'no-cache',
            pragma: 'no-cache',
            'x-ui-app': 'mailcom.webmailer.mail-list/6.6.3',
            authorization: basicAuthorization,
          },
          body: new URLSearchParams({
            grant_type: 'urn:mam:oauth:grant-type:spa',
            scope: 'mail_mailbox_r',
          }),
        },
      );
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch {}
      return {
        ok: response.ok,
        status: response.status,
        token: body?.access_token || body?.accessToken || '',
      };
    }, { sid, basicAuthorization: MAILCOM_OAUTH_BASIC });
    if (tokenResult?.ok && tokenResult.token) accessToken = tokenResult.token;
  }
  const response = await page.request.post(`https://maillist.mail.com/Mailbox/Mail?folderTypeOrId=${encodeURIComponent(folderTypeOrId)}&offset=${Number(offset) || 0}&amount=${Number(amount) || 50}&orderBy=INTERNALDATE%20DESC&no_cache=${encodeURIComponent(noCache)}`, {
    headers: {
      accept: 'application/vnd.1and1.mms.unified-maillist-v1+json; charset=utf-8',
      'content-type': 'application/vnd.1and1.mms.inboxadrequest-v1+json; charset=utf-8',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      origin: 'https://webmailer.mail.com',
      referer: 'https://webmailer.mail.com/',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'x-request-id': `${Math.random().toString(16).slice(2, 10)}-${Date.now().toString(16)}`,
      'x-ui-app': 'mailcom.webmailer.mail-list/6.6.3',
    },
    data: {
      aditionContext: {
        brand: 'mailcom',
        category: 'mail',
        section: '3c/folder',
        tagid: 'inline',
        layoutclass: 'b',
      },
      deviceContext: {
        app: { name: 'browser' },
        deviceclass: 'b',
      },
      adBlocker: false,
      mailboxContext: {
          currentPage: Math.floor((Number(offset) || 0) / (Number(amount) || 50)) + 1,
        visibleMessages: 8,
      },
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  return { ok: response.ok(), status: response.status(), text, body };
}

async function waitForInboxReady(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await directFetchInbox(page);
      if (last?.ok && Array.isArray(last.body?.mailListElements)) return last;
    } catch (error) {
      last = { ok: false, status: 0, error: error.message };
    }
    await page.waitForTimeout(1000);
  }
  return last || { ok: false, status: 0, error: 'inbox_not_ready' };
}

async function blockHeavyResources(context) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    const type = request.resourceType();
    if (['image', 'media', 'font'].includes(type)) return route.abort().catch(() => {});
    if (/doubleclick|googlesyndication|adition|adfarm|tealium|analytics|tracking|facebook|hotjar/i.test(url)) {
      return route.abort().catch(() => {});
    }
    return route.continue().catch(() => {});
  });
}

function storageStateExists(storageStatePath) {
  if (!storageStatePath) return false;
  try {
    return fs.existsSync(storageStatePath) && fs.statSync(storageStatePath).size > 10;
  } catch {
    return false;
  }
}

async function directFetchMailBody(page, mailId) {
  const sid = await page.evaluate(() => {
    function candidateSidFromText(text) {
      const match = String(text || '').match(/[a-f0-9]{64,}/i);
      return match ? match[0] : '';
    }

    function findSid() {
      const urls = [
        location.href,
        document.referrer,
        ...performance.getEntriesByType('resource').map((entry) => entry.name),
      ];
      for (const raw of urls) {
        try {
          const url = new URL(raw);
          const sid = url.searchParams.get('sid') || url.searchParams.get('navsid');
          if (sid) return sid;
          const guessed = candidateSidFromText(raw);
          if (guessed) return guessed;
        } catch {}
      }
      for (const storage of [localStorage, sessionStorage]) {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          const value = storage.getItem(key);
          const sid = candidateSidFromText(`${key || ''} ${value || ''}`);
          if (sid) return sid;
        }
      }
      return '';
    }
    return findSid();
  });
  if (!sid) return { ok: false, status: 0, error: 'sid_not_found' };

  const webmailFrame = webmailFrameForPage(page);

  const tokenResult = await webmailFrame.evaluate(async ({ sid, basicAuthorization }) => {
    function timeoutSignal(ms) {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    }

    const tokenResponse = await fetch(`https://oauthbridge.navigator-lxa.mail.com/navigator/oauth2/token?sid=${encodeURIComponent(sid)}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: '*/*',
        'content-type': 'application/x-www-form-urlencoded',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'x-ui-app': 'mailcom.webmailer.mail-detail/7.40.1',
        authorization: basicAuthorization,
      },
      body: new URLSearchParams({
        grant_type: 'urn:mam:oauth:grant-type:spa',
        scope: 'mail_mailbox_r',
      }),
      signal: timeoutSignal(5000),
    });
    const tokenText = await tokenResponse.text();
    let tokenBody = null;
    try { tokenBody = tokenText ? JSON.parse(tokenText) : null; } catch {}
    const accessToken = tokenBody?.access_token || tokenBody?.accessToken || '';
    if (!tokenResponse.ok || !accessToken) {
      return {
        ok: false,
        status: tokenResponse.status,
        error: 'token_unavailable',
        tokenBodyKeys: tokenBody && typeof tokenBody === 'object' ? Object.keys(tokenBody) : [],
        frameUrl: location.href,
      };
    }

    return {
      ok: true,
      status: tokenResponse.status,
      token: accessToken,
    };
  }, { sid, basicAuthorization: MAILCOM_OAUTH_BASIC });

  if (!tokenResult?.ok || !tokenResult.token) return tokenResult;

  const headerNoCache = `a-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const headerResponse = await page.request.get(
    `https://webmail-cats-live.mail.com/mailbox/primary/mailheader/${encodeURIComponent(String(mailId || ''))}?absoluteURI=false&no_cache=${encodeURIComponent(headerNoCache)}`,
    {
      headers: {
        accept: 'application/vnd.ui.trinity.message+json; charset=utf-8; client-meta=mail-drop;',
        authorization: `Bearer ${tokenResult.token}`,
        origin: 'https://webmailer.mail.com',
        referer: 'https://webmailer.mail.com/',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'x-request-id': `${Math.random().toString(16).slice(2, 10)}-${Date.now().toString(16)}`,
        'x-ui-app': 'mailcom.webmailer.mail-detail/7.40.1',
      },
      timeout: 5000,
    },
  );
  const headerText = await headerResponse.text();
  let headerBody = null;
  try { headerBody = headerText ? JSON.parse(headerText) : null; } catch {}
  if (!headerResponse.ok()) {
    return { ok: false, status: headerResponse.status(), error: 'header_unavailable' };
  }

  const bodyPath = String(headerBody?.mailBodyURI || `${mailId}/Body`).replace(/^Mail\//, '');
  const noCache = `a-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const bodyResponse = await page.request.post(
    `https://mailcom.mailbody-ui.de/Mail/${encodeURIComponent(bodyPath).replace(/%2F/g, '/')}/html?target_origin=${encodeURIComponent('https://webmailer.mail.com')}&no_cache=${encodeURIComponent(noCache)}`,
    {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://webmailer.mail.com',
        referer: 'https://webmailer.mail.com/',
      },
      form: { access_token: tokenResult.token },
      timeout: 8000,
    },
  );
  return {
    ok: bodyResponse.ok(),
    status: bodyResponse.status(),
    html: await bodyResponse.text(),
  };
}

async function clickIfVisible(locator, timeout = 1500) {
  try {
    if (await locator.isVisible({ timeout })) {
      await locator.click({ timeout });
      return true;
    }
  } catch {}
  return false;
}

async function fillFirst(page, selectors, value, label) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: 4000 });
      await locator.fill(value, { timeout: 5000 });
      return selector;
    } catch {}
  }
  throw new Error(`Cannot find ${label} input.`);
}

async function submitLogin(page, email, password, timeoutMs) {
  await page.goto('https://www.mail.com/', { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await clickIfVisible(page.getByRole('button', { name: /accept|agree|save|ok/i }), 2500);
  await clickIfVisible(page.getByRole('button', { name: /log\s*in|login|sign\s*in/i }), 2500);
  await clickIfVisible(page.getByRole('link', { name: /log\s*in|login|sign\s*in/i }), 2500);

  await fillFirst(page, [
    'input[name="username"]',
    'input[type="email"]',
    'input[id*="login" i]',
    'input[autocomplete="username"]',
  ], email, 'email');
  await fillFirst(page, [
    'input[name="password"]',
    'input[type="password"]',
    'input[autocomplete="current-password"]',
  ], password, 'password');

  const navigation = page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  const clicked = await clickIfVisible(page.locator('button[type="submit"], input[type="submit"]').first(), 3000)
    || await clickIfVisible(page.getByRole('button', { name: /log\s*in|login|sign\s*in|continue/i }), 3000);
  if (!clicked) await page.keyboard.press('Enter');
  await navigation;

  await page.waitForURL(/navigator-lxa\.mail\.com|webmailer\.mail\.com|mail\.com/i, { timeout: timeoutMs }).catch(() => {});
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (/invalid|incorrect|wrong|try again|login failed|password/i.test(bodyText) && !/inbox|mailbox|compose/i.test(bodyText)) {
    throw new Error('Login may have failed. The page shows an error-like message.');
  }
}

async function waitForVerificationCode(page, timeoutMs, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let found = null;
  const seenSubjects = new Set();
  const scannedMails = new Map();
  const bodyAttempts = [];
  const clickedVisibleMailIndexes = new Set();
  let allowNextMailBodyResponse = false;

  function rememberMail(mail) {
    if (!mail?.subject && !mail?.sender) return;
    if (mail.subject) seenSubjects.add(`${mail.sender} ${mail.subject}`);
    const key = mail.id || `${mail.sender}|${mail.subject}|${mail.receivedAt || ''}`;
    if (!scannedMails.has(key)) scannedMails.set(key, mailLogEntry(mail));
  }

  function targetMailById(mailId) {
    if (!mailId) return null;
    for (const entry of scannedMails.values()) {
      if (entry.id === mailId && entry.target) return entry;
    }
    return null;
  }

  function attachScan(result) {
    return {
      ...result,
      seenSubjects: [...seenSubjects].slice(0, 10),
      scannedMails: [...scannedMails.values()].slice(0, 20),
      bodyAttempts: bodyAttempts.slice(0, 10),
      clickedVisibleMailIndexes: [...clickedVisibleMailIndexes],
    };
  }

  async function extractOpenedMailCode(frame, mail) {
    const openedDeadline = Math.min(deadline, Date.now() + 10000);
    let lastResult = null;
    while (Date.now() < openedDeadline) {
      await page.waitForTimeout(700);
      const frameTexts = await Promise.all(page.frames().map((item) => (
        item.locator('body').innerText({ timeout: 1000 }).catch(() => '')
      )));
      const openedText = frameTexts.filter(Boolean).join('\n');
      lastResult = extractVerificationCodeFromMail({
        ...mail,
        text: openedText,
      }, { minScore: 15 });
      if (lastResult.found) return lastResult;
    }
    return lastResult || { found: false, code: null, reason: 'opened_mail_text_unavailable', mail };
  }

  async function waitForBodyResponseResult(ms = 8000) {
    const bodyDeadline = Math.min(deadline, Date.now() + ms);
    while (Date.now() < bodyDeadline && !found) {
      await page.waitForTimeout(250);
    }
    return Boolean(found);
  }

  async function clickVisibleChatGptMailByIndex(frame, index, mail = null) {
    if (clickedVisibleMailIndexes.has(index)) return false;
    const subjectPrefix = String(mail?.subject || '').slice(0, 18).trim();
    const subjectRows = subjectPrefix
      ? frame.getByText(new RegExp(escapeRegExp(subjectPrefix), 'i'))
      : frame.getByText(/temporary\s+ChatGPT|c[oó]digo\s+temporal|verification\s+code/i);
    const target = subjectRows.nth(index);
    if (await clickIfVisible(target, 800)) {
      clickedVisibleMailIndexes.add(index);
      return true;
    }
    return false;
  }

  page.on('response', async (response) => {
    if (found) return;
    const url = response.url();
    if (/mailbody-ui\.de\/Mail\/[^/]+\/Body\/html/i.test(url)) {
      const mailId = mailIdFromMailBodyUrl(url);
      const mail = targetMailById(mailId) || (allowNextMailBodyResponse ? {
        id: mailId,
        sender: 'ChatGPT <noreply@tm.openai.com>',
        subject: 'ChatGPT verification code',
        receivedAt: new Date().toISOString(),
        target: true,
      } : null);
      allowNextMailBodyResponse = false;
      const status = response.status();
      let html = '';
      try { html = await response.text(); } catch {}
      bodyAttempts.push({
        mailId,
        ok: status >= 200 && status < 300,
        status,
        error: status >= 200 && status < 300 ? null : 'mail_body_response_failed',
        frameUrl: url.replace(/no_cache=[^&]+/g, 'no_cache=...'),
        htmlLength: html.length,
      });
      if (found || !mail || isExcludedMail(mail, options) || !html) return;
      const bodyResult = extractVerificationCodeFromMail({
        ...mail,
        html,
        text: html,
      }, { minScore: 15 });
      if (bodyResult.found && !isExcludedMail({ ...mail, code: bodyResult.code }, options)) {
        found = attachScan({ ...bodyResult, source: 'mail-body-response' });
      }
      return;
    }
    if (!/mail|webmailer|mailbox|maillist/i.test(url)) return;
    let text = '';
    try { text = await response.text(); } catch { return; }
    if (!text) return;
    try {
      const json = JSON.parse(text);
      for (const mail of mailsFromMailListJson(json)) {
        rememberMail(mail);
        if (!isChatGptOpenAiMail(mail)) continue;
        if (isExcludedMail(mail, options)) continue;
        const result = extractVerificationCodeFromMail(mail, { minScore: 15 });
        if (result.found) {
          if (isExcludedMail({ ...mail, code: result.code }, options)) continue;
          found = attachScan({ ...result, source: 'mail-list-api' });
          return;
        }
      }
    } catch {}
  });

  while (Date.now() < deadline && !found) {
    try {
      const inbox = await directFetchInbox(page);
      if (inbox?.ok) {
        for (const mail of mailsFromMailListJson(inbox.body)) {
          rememberMail(mail);
          if (!isChatGptOpenAiMail(mail)) continue;
          if (isExcludedMail(mail, options)) continue;
          const headerResult = extractVerificationCodeFromMail(mail, { minScore: 15 });
          if (headerResult.found) {
            if (isExcludedMail({ ...mail, code: headerResult.code }, options)) continue;
            found = attachScan({ ...headerResult, source: 'direct-inbox-api' });
            break;
          }
          const directBody = await directFetchMailBody(page, mail.id).catch((error) => ({
            ok: false,
            status: 0,
            error: error.message,
          }));
          bodyAttempts.push({
            mailId: mail.id,
            ok: Boolean(directBody?.ok),
            status: directBody?.status || 0,
            error: directBody?.ok ? null : directBody?.error || 'mail_body_direct_failed',
            frameUrl: directBody?.frameUrl || null,
            htmlLength: String(directBody?.html || '').length,
          });
          if (directBody?.ok && directBody.html) {
            const bodyResult = extractVerificationCodeFromMail({
              ...mail,
              html: directBody.html,
              text: directBody.html,
            }, { minScore: 15 });
            if (bodyResult.found && !isExcludedMail({ ...mail, code: bodyResult.code }, options)) {
              found = attachScan({ ...bodyResult, source: 'direct-mail-body-api' });
              break;
            }
          }
          const mailFrame = webmailFrameForPage(page);
          const visibleIndex = Math.max(0, [...scannedMails.values()].filter((item) => item.target).findIndex((item) => item.id === mail.id));
          allowNextMailBodyResponse = true;
          const clickedMail = await clickVisibleChatGptMailByIndex(mailFrame, visibleIndex, mail);
          if (clickedMail) {
            if (await waitForBodyResponseResult()) {
              break;
            }
          } else {
            allowNextMailBodyResponse = false;
          }
        }
      }
    } catch {}
    if (found) break;

    const mailFrame = webmailFrameForPage(page);
    const nextVisibleIndex = [0, 1, 2, 3, 4].find((index) => !clickedVisibleMailIndexes.has(index));
    if (Number.isInteger(nextVisibleIndex)) {
      allowNextMailBodyResponse = true;
    }
    if (Number.isInteger(nextVisibleIndex) && await clickVisibleChatGptMailByIndex(mailFrame, nextVisibleIndex)) {
      if (await waitForBodyResponseResult()) {
        break;
      }
    } else {
      allowNextMailBodyResponse = false;
    }

    await page.waitForTimeout(1500);

    if (Date.now() + 5000 < deadline) {
      await clickIfVisible(page.getByRole('link', { name: /inbox|收件箱/i }), 1000)
        || await clickIfVisible(page.getByRole('button', { name: /inbox|refresh|刷新/i }), 1000);
    }
  }

  if (!found) {
    return attachScan({
      found: false,
      code: null,
      reason: 'timeout',
    });
  }
  return attachScan(found);
}

async function fetchMailComVerificationCode({
  email,
  password,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headed = false,
  proxy = '',
  executable = '',
  storageStatePath = '',
  diagnosticDir = '',
  excludeMailIds = [],
  excludeCodes = [],
} = {}) {
  if (!email || !password) throw new Error('Email and password are required.');
  const deadline = Date.now() + timeoutMs;
  const remainingMs = () => Math.max(0, deadline - Date.now());

  const { browser, library } = await launchBrowser({ headed, proxy, executable });
  const contextOptions = {
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    ignoreHTTPSErrors: false,
  };
  const useStoredSession = false;
  if (useStoredSession && storageStateExists(storageStatePath)) contextOptions.storageState = storageStatePath;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    let session = contextOptions.storageState ? 'cached' : 'login';
    let ready = null;
    if (contextOptions.storageState) {
      await page.goto('https://webmailer.mail.com/', { waitUntil: 'domcontentloaded', timeout: Math.min(remainingMs(), 15000) }).catch(() => {});
      ready = await waitForInboxReady(page, Math.min(remainingMs(), 10000));
      if (!ready?.ok) session = 'login';
    }
    if (session === 'login') {
      await submitLogin(page, email, password, Math.max(1000, remainingMs()));
      await blockHeavyResources(context);
    }
    const remaining = remainingMs();
    const result = remaining > 0
      ? await waitForVerificationCode(page, remaining, { excludeMailIds, excludeCodes })
      : { found: false, code: null, reason: 'timeout' };
    let diagnostic = null;
    if (!result.found && diagnosticDir) {
      try {
        fs.mkdirSync(diagnosticDir, { recursive: true });
        const screenshotPath = path.join(diagnosticDir, `mail-com-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5000 });
        diagnostic = {
          url: page.url(),
          screenshotPath,
        };
      } catch (error) {
        diagnostic = { error: error.message, url: page.url() };
      }
    }
    if (result.found && storageStatePath) {
      fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
      await context.storageState({ path: storageStatePath }).catch(() => {});
    }
    return {
      ...result,
      browser: library,
      session,
      inboxReady: ready ? { ok: Boolean(ready.ok), status: ready.status || null, error: ready.error || null } : null,
      diagnostic,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const email = args.email || args.username || process.env.MAIL_COM_EMAIL || await ask('mail.com email: ');
  const password = args.password || process.env.MAIL_COM_PASSWORD || await askHidden('mail.com password: ');
  if (!email || !password) throw new Error('Email and password are required.');

  const timeoutMs = Math.max(10000, Number(args.timeout || DEFAULT_TIMEOUT_MS));
  console.error('[mail.com] Logging in...');
  const result = await fetchMailComVerificationCode({
    email,
    password,
    timeoutMs,
    headed: Boolean(args.headed),
    proxy: args.proxy || '',
    executable: args.executable || '',
  });
  console.error('[mail.com] Waiting for verification code...');
  if (args.json) {
    console.log(JSON.stringify({
      found: Boolean(result.found),
      code: result.code || null,
      source: result.source || null,
      reason: result.reason || null,
      subject: result.mail?.subject || null,
      sender: result.mail?.sender || null,
      seenSubjects: result.seenSubjects || undefined,
    }, null, 2));
  } else if (result.found) {
    console.log(result.code);
    console.error(`[mail.com] Found via ${result.source || 'unknown'}${result.mail?.subject ? ` · ${result.mail.subject}` : ''}`);
  } else {
    console.error(`[mail.com] No code found before timeout. Reason: ${result.reason}`);
    if (result.seenSubjects?.length) console.error(`[mail.com] Seen subjects: ${result.seenSubjects.join(' | ')}`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[mail.com] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  fetchMailComVerificationCode,
  parseArgs,
  pickBrowserLibrary,
  launchBrowser,
  blockHeavyResources,
  submitLogin,
  waitForVerificationCode,
  directFetchInbox,
  directFetchMailBody,
  mailsFromMailListJson,
  webmailFrameForPage,
  waitForInboxReady,
};
