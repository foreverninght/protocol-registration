'use strict';

const crypto = require('node:crypto');

function firstLine(value) {
  return String(value || '').split(/\r?\n/)[0].slice(0, 500);
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}

async function settle(promise, timeoutMs, fallback) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), timeoutMs); }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

async function collectVisibleElements(page) {
  return settle(page.evaluate(() => {
    const pick = (selector, limit) => [...document.querySelectorAll(selector)].slice(0, limit).map((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        name: el.getAttribute('name') || null,
        id: el.id || null,
        role: el.getAttribute('role') || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        text: (el.innerText || el.textContent || '').trim().slice(0, 160),
        placeholder: el.getAttribute('placeholder') || null,
        visible,
      };
    });
    return {
      buttons: pick('button, a[role="button"], a[href]', 80),
      inputs: pick('input, textarea, select', 80),
      headings: pick('h1,h2,h3,[role="heading"]', 40),
    };
  }), 3000, { buttons: [], inputs: [], headings: [] });
}

async function capturePageSnapshot({ page, evidence, label, error }) {
  if (!page || !evidence) return null;
  const safeLabel = String(label || 'page').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80);
  const at = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = `${at}-${safeLabel}`;

  const url = typeof page.url === 'function' ? page.url() : null;
  const title = await settle(page.title?.(), 2000, null);
  const elements = await collectVisibleElements(page);
  const html = await settle(page.content?.(), 3000, '');
  const htmlArtifact = await evidence.writeArtifact(`${prefix}.html`, html || '');
  let screenshotArtifact = null;
  if (typeof page.screenshot === 'function') {
    const screenshot = await settle(page.screenshot({ fullPage: true, type: 'png', timeout: 5000 }), 6000, null);
    if (screenshot) screenshotArtifact = await evidence.writeArtifact(`${prefix}.png`, screenshot, { encoding: undefined });
  }

  const snapshot = {
    label: safeLabel,
    url,
    title,
    error: error ? { code: error.code || 'ERROR', message: firstLine(error.message || error) } : null,
    html: {
      path: htmlArtifact.path,
      bytes: htmlArtifact.bytes,
      sha256: hash(html),
    },
    screenshot: screenshotArtifact,
    visible: elements,
  };
  await evidence.record({ type: 'browser.page_snapshot', payload: snapshot });
  return snapshot;
}

module.exports = { capturePageSnapshot, collectVisibleElements };
