'use strict';

const { spawn } = require('node:child_process');

function toCamoufoxProxy(proxy) {
  if (!proxy) return undefined;
  const protocol = String(proxy.protocol || proxy.scheme || proxy.type || "http").toLowerCase().replace(":", "");
  const server = `://:`;
  return {
    server,
    username: proxy.username || undefined,
    password: proxy.password || undefined,
  };
}

function toPlaywrightProxy(proxy) {
  if (!proxy) return undefined;
  return {
    server: `http://${proxy.host}:${proxy.port}`,
    username: proxy.username || undefined,
    password: proxy.password || undefined,
  };
}

function headlessForPlaywright(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['0', 'false', 'no', 'off', 'headed'].includes(normalized)) return false;
  return true;
}

function wantsVirtualDisplay(value) {
  return String(value || '').trim().toLowerCase() === 'virtual';
}

function buildCamoufoxLaunchOptions({ config, proxy }) {
  const options = {
    headless: config.browser.headless,
    os: config.browser.os || 'windows',
    proxy: toCamoufoxProxy(proxy),
    geoip: Boolean(config.browser.geoip),
    block_images: Boolean(config.browser.blockImages),
    block_webrtc: Boolean(config.browser.blockWebrtc),
    block_webgl: false,
    humanize: config.browser.humanize || 1.5,
    screen: config.browser.screen || {
      minWidth: 1366,
      maxWidth: 1920,
      minHeight: 768,
      maxHeight: 1080,
    },
    window: config.browser.window || [1366, 768],
    enable_cache: Boolean(config.browser.enableCache),
    firefox_user_prefs: {
      'signon.rememberSignons': false,
      'signon.autofillForms': false,
      'signon.autologin.proxy': false,
      'signon.generation.enabled': false,
      'signon.management.page.breach-alerts.enabled': false,
      'extensions.formautofill.addresses.enabled': false,
      'extensions.formautofill.creditCards.enabled': false,
      'dom.security.credentialmanagement.enabled': false,
      'identity.fxaccounts.enabled': false,
    },
    timeout: config.browser.launchTimeoutMs,
  };
  if (config.browser.locale) options.locale = config.browser.locale;
  return options;
}

function buildChromiumLaunchOptions({ config, proxy }) {
  const options = {
    headless: headlessForPlaywright(config.browser.headless),
    proxy: toPlaywrightProxy(proxy),
    timeout: config.browser.launchTimeoutMs,
    args: [
      '--disable-save-password-bubble',
      '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication,AutofillEnableAccountWalletStorage',
      '--disable-blink-features=AutomationControlled',
      '--password-store=basic',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  };
  if (config.browser.chromiumExecutablePath) options.executablePath = config.browser.chromiumExecutablePath;
  if (config.browser.chromiumChannel && !options.executablePath) options.channel = config.browser.chromiumChannel;
  return options;
}

function chromiumPlatformLabel(os) {
  const value = String(os || '').toLowerCase();
  if (value.includes('win')) return 'Windows';
  if (value.includes('mac')) return 'macOS';
  if (value.includes('linux')) return 'Linux';
  return 'Windows';
}

function chromiumNavigatorPlatform(os) {
  const value = String(os || '').toLowerCase();
  if (value.includes('win')) return 'Win32';
  if (value.includes('mac')) return 'MacIntel';
  if (value.includes('linux')) return 'Linux x86_64';
  return 'Win32';
}

function defaultChromiumUserAgent({ config }) {
  if (config.browser.chromiumUserAgent) return config.browser.chromiumUserAgent;
  const major = Number(config.browser.chromiumMajor) || 139;
  const os = chromiumPlatformLabel(config.browser.os);
  if (os === 'macOS') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  if (os === 'Linux') {
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function chromiumClientHints({ config }) {
  const major = Number(config.browser.chromiumMajor) || 139;
  return {
    'sec-ch-ua': `"Not=A?Brand";v="99", "Google Chrome";v="${major}", "Chromium";v="${major}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${chromiumPlatformLabel(config.browser.os)}"`,
  };
}

function languagesForLocale(locale) {
  const primary = String(locale || 'en-US').trim() || 'en-US';
  const base = primary.split('-')[0] || primary;
  return primary === base ? [primary] : [primary, base];
}

function localeForProxy(proxy, fallback = 'en-US') {
  const country = String(proxy?.country || '').trim().toUpperCase();
  const locales = {
    GB: 'en-GB',
    US: 'en-US',
    SG: 'en-SG',
    JP: 'ja-JP',
    MY: 'ms-MY',
    CA: 'en-CA',
    AU: 'en-AU',
  };
  return locales[country] || fallback;
}

function acceptLanguageForLocale(locale) {
  return languagesForLocale(locale)
    .map((item, index) => (index === 0 ? item : `${item};q=${Math.max(0.1, 1 - index / 10).toFixed(1)}`))
    .join(',');
}

function buildChromiumContextOptions({ config }) {
  const locale = config.browser.locale || 'en-US';
  const options = {
    viewport: {
      width: Number(config.browser.window?.[0]) || 1366,
      height: Number(config.browser.window?.[1]) || 768,
    },
    screen: {
      width: Number(config.browser.window?.[0]) || 1366,
      height: Number(config.browser.window?.[1]) || 768,
    },
    javaScriptEnabled: true,
    bypassCSP: false,
    ignoreHTTPSErrors: false,
    userAgent: defaultChromiumUserAgent({ config }),
    locale,
    ...(timezone ? { timezone } : {}),
    extraHTTPHeaders: {
      'accept-language': languagesForLocale(locale).map((item, index) => (index === 0 ? item : `${item};q=${Math.max(0.1, 1 - index / 10).toFixed(1)}`)).join(','),
      ...chromiumClientHints({ config }),
    },
  };
  return options;
}

function buildCloakLaunchOptions({ config, proxy, display }) {
  const locale = config.browser.locale || localeForProxy(proxy);
  const timezone = config.browser.timezone || proxy.timezone || null;
  const options = {
    proxy: toPlaywrightProxy(proxy),
    geoip: Boolean(config.browser.geoip),
    headless: wantsVirtualDisplay(config.browser.headless) ? false : headlessForPlaywright(config.browser.headless),
    humanize: true,
    humanPreset: 'careful',
    locale,
    extraHTTPHeaders: {
      'accept-language': acceptLanguageForLocale(locale),
    },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-quic',
      '--disable-save-password-bubble',
      '--disable-features=PasswordManagerOnboarding,AutofillServerCommunication,AutofillEnableAccountWalletStorage,UseDnsHttpsSvcb,EncryptedClientHello',
      '--password-store=basic',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  };
  if (display) options.env = { DISPLAY: display };
  if (config.browser.cloakReleaseChannel) options.releaseChannel = config.browser.cloakReleaseChannel;
  if (config.browser.cloakVersion) options.browserVersion = config.browser.cloakVersion;
  return options;
}

function cloakUserDataDir({ config }) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${config.browser.cloakProfilesDir.replace(/[\\/]+$/, '')}/session-${suffix}`;
}

function buildCloakPersistentContextOptions({ config, proxy, display }) {
  return {
    userDataDir: cloakUserDataDir({ config }),
    ...buildCloakLaunchOptions({ config, proxy, display }),
  };
}

function waitForProcessExit(child, timeoutMs = 1000) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function stopChildProcess(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  try { child.kill('SIGTERM'); } catch {}
  return waitForProcessExit(child, 1000).then(() => {
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
  });
}

async function closeBrowserTarget(target, label, timeoutMs = 5000) {
  if (!target || typeof target.close !== 'function') return;
  let timer;
  try {
    await Promise.race([
      target.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label || 'browser'} close timed out`);
          error.code = 'BROWSER_CLOSE_TIMEOUT';
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function startVirtualDisplay({ config }) {
  if (!wantsVirtualDisplay(config.browser.headless) || process.platform !== 'linux') {
    return null;
  }
  const width = Number(config.browser.window?.[0]) || 1366;
  const height = Number(config.browser.window?.[1]) || 768;
  const base = 90 + Math.trunc(Math.random() * 100);
  let lastError = null;
  for (let i = 0; i < 40; i += 1) {
    const displayNumber = 90 + ((base + i) % 100);
    const display = `:${displayNumber}`;
    const child = spawn('Xvfb', [
      display,
      '-screen',
      '0',
      `${width}x${height}x24`,
      '-ac',
      '-nolisten',
      'tcp',
      '-noreset',
    ], {
      stdio: 'ignore',
      detached: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (child.exitCode === null) {
      return {
        display,
        process: child,
        async close() {
          await stopChildProcess(child);
        },
      };
    }
    lastError = new Error(`Xvfb display ${display} exited before browser launch`);
  }
  const error = lastError || new Error('unable to start virtual display');
  error.code = 'VIRTUAL_DISPLAY_UNAVAILABLE';
  throw error;
}

async function launchCamoufoxSession({ config, proxy }) {
  let camoufox;
  try {
    camoufox = require('camoufox-js');
  } catch (error) {
    error.code = 'CAMOUFOX_MODULE_UNAVAILABLE';
    throw error;
  }

  const launcher = camoufox.Camoufox || camoufox.launch || camoufox.camoufox?.launch || camoufox.default?.launch;
  if (typeof launcher !== 'function') {
    const error = new Error('camoufox-js launcher was not found');
    error.code = 'CAMOUFOX_LAUNCHER_UNAVAILABLE';
    throw error;
  }

  const browser = await launcher(buildCamoufoxLaunchOptions({ config, proxy }));
  try {
    return {
      browser,
      context: await browser.newContext(),
      engine: 'camoufox',
    };
  } catch (error) {
    try { await browser?.close?.(); } catch {}
    throw error;
  }
}

async function launchCloakSession({ config, proxy }) {
  let cloak;
  try {
    cloak = await import('cloakbrowser');
  } catch (error) {
    error.code = 'CLOAK_MODULE_UNAVAILABLE';
    throw error;
  }
  const launchPersistentContext = cloak.launchPersistentContext || cloak.default?.launchPersistentContext;
  if (typeof launchPersistentContext !== 'function') {
    const error = new Error('cloakbrowser launchPersistentContext was not found');
    error.code = 'CLOAK_LAUNCHER_UNAVAILABLE';
    throw error;
  }
  let virtualDisplay = null;
  let context = null;
  let previousDisplay;
  let changedDisplay = false;
  try {
    virtualDisplay = await startVirtualDisplay({ config });
    if (virtualDisplay?.display) {
      previousDisplay = process.env.DISPLAY;
      process.env.DISPLAY = virtualDisplay.display;
      changedDisplay = true;
    }
    context = await launchPersistentContext(buildCloakPersistentContextOptions({
      config,
      proxy,
      display: virtualDisplay?.display || '',
    }));
    if (changedDisplay) {
      if (previousDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = previousDisplay;
      changedDisplay = false;
    }
    const browser = typeof context.browser === 'function' ? context.browser() : null;
    return {
      browser,
      context,
      engine: 'cloak',
      async close() {
        try {
          await closeBrowserTarget(context, 'cloak_context');
        } finally {
          try { await closeBrowserTarget(browser, 'cloak_browser'); } finally {
            await virtualDisplay?.close?.();
          }
        }
      },
    };
  } catch (error) {
    if (changedDisplay) {
      if (previousDisplay === undefined) delete process.env.DISPLAY;
      else process.env.DISPLAY = previousDisplay;
    }
    try { await closeBrowserTarget(context, 'cloak_context'); } catch {}
    try { await closeBrowserTarget(context?.browser?.(), 'cloak_browser'); } catch {}
    try { await virtualDisplay?.close?.(); } catch {}
    throw error;
  }
}

async function launchChromiumSession({ config, proxy }) {
  let playwright;
  try {
    playwright = require('playwright-core');
  } catch (error) {
    error.code = 'PLAYWRIGHT_CORE_UNAVAILABLE';
    throw error;
  }
  if (!playwright.chromium?.launch) {
    const error = new Error('playwright chromium launcher was not found');
    error.code = 'CHROMIUM_LAUNCHER_UNAVAILABLE';
    throw error;
  }
  const browser = await playwright.chromium.launch(buildChromiumLaunchOptions({ config, proxy }));
  try {
    const context = await browser.newContext(buildChromiumContextOptions({ config }));
    const languages = languagesForLocale(config.browser.locale || 'en-US');
    const platform = chromiumNavigatorPlatform(config.browser.os);
    await context.addInitScript(({ platform, languages }) => {
      try {
        Object.defineProperty(Navigator.prototype, 'webdriver', {
          get() { return false; },
          configurable: true,
        });
        Object.defineProperty(Navigator.prototype, 'platform', {
          get() { return platform; },
          configurable: true,
        });
        Object.defineProperty(Navigator.prototype, 'languages', {
          get() { return languages; },
          configurable: true,
        });
        Object.defineProperty(Navigator.prototype, 'language', {
          get() { return languages[0]; },
          configurable: true,
        });
      } catch {}
    }, { platform, languages });
    return {
      browser,
      context,
      engine: 'chromium',
    };
  } catch (error) {
    try { await browser?.close?.(); } catch {}
    throw error;
  }
}

async function createFingerprintBrowserSession({ config, proxy, collectorFactory }) {
  if (!config.browser.enabled) {
    const error = new Error('browser execution is disabled; set BROWSER_RUN_ENABLED=1 to run real registration');
    error.code = 'BROWSER_DISABLED';
    throw error;
  }

  const launched = config.browser.engine === 'chromium'
    ? await launchChromiumSession({ config, proxy })
    : config.browser.engine === 'cloak'
      ? await launchCloakSession({ config, proxy })
      : await launchCamoufoxSession({ config, proxy });
  const { browser } = launched;
  const closeLaunched = async () => {
    if (typeof launched.close === 'function') {
      await launched.close();
      return;
    }
    try { await context?.close?.(); } finally {
      await browser?.close?.();
    }
  };
  let context;
  let page;
  let collector;
  try {
    context = launched.context;
    page = await context.newPage();
    collector = collectorFactory ? await collectorFactory({ browser, context, page }) : null;
    return {
      browser,
      context,
      page,
      collector,
      engine: launched.engine,
      async close() {
        try { await collector?.stop?.(); } finally {
          await closeLaunched();
        }
      },
    };
  } catch (error) {
    try { await collector?.stop?.(); } catch {}
    try { await closeLaunched(); } catch {}
    throw error;
  }
}

module.exports = {
  createFingerprintBrowserSession,
  toCamoufoxProxy,
  toPlaywrightProxy,
  buildCamoufoxLaunchOptions,
  buildChromiumLaunchOptions,
  buildChromiumContextOptions,
  buildCloakLaunchOptions,
  buildCloakPersistentContextOptions,
  localeForProxy,
  acceptLanguageForLocale,
  headlessForPlaywright,
  wantsVirtualDisplay,
};
