'use strict';

const { parseAllowedOrigins } = require('./request-boundary');

const path = require('node:path');
const {
  executionImplementation,
  fingerprintBrowser,
} = require('../registration/execution-catalog');

function numberFromEnv(env, name, fallback, min, max) {
  const raw = Number(env[name]);
  const value = Number.isFinite(raw) ? Math.trunc(raw) : fallback;
  return Math.max(min, Math.min(max, value));
}

function booleanFromEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function stringFromEnv(env, name, fallback = '') {
  const value = String(env[name] || '').trim();
  return value || fallback;
}

function stringListFromEnv(env, names = []) {
  const raw = names.map((name) => env[name]).find((value) => String(value || '').trim());
  return String(raw || '')
    .split(/[\n,，;；\s]+/u)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function registrationEntryBranchFromEnv(env) {
  const raw = stringFromEnv(env, 'REGISTRATION_ENTRY_BRANCH', 'freepp');
  const implementation = executionImplementation(raw);
  if (implementation) return implementation.key;
  const error = new Error(`unsupported REGISTRATION_ENTRY_BRANCH: ${raw}`);
  error.code = 'REGISTRATION_ENTRY_BRANCH_UNSUPPORTED';
  error.status = 400;
  error.retryableProxy = false;
  throw error;
}

function freeppRuntimeConfigFromEnv(env, {
  pythonEnv = 'FREEPP_PYTHON',
  backendEnv = 'FREEPP_BACKEND_DIR',
  sentinelEnv = 'OPENAI_SENTINEL_MODE',
  timeoutEnv = 'FREEPP_TIMEOUT_MS',
  backendFallback,
  fallback = {},
} = {}) {
  return Object.freeze({
    python: stringFromEnv(env, pythonEnv, fallback.python || stringFromEnv(env, 'PYTHON', 'python')),
    backendDir: path.resolve(stringFromEnv(env, backendEnv, fallback.backendDir || backendFallback)),
    sentinelMode: stringFromEnv(env, sentinelEnv, fallback.sentinelMode || 'pure'),
    timeoutMs: numberFromEnv(env, timeoutEnv, fallback.timeoutMs || 10 * 60 * 1000, 30000, 60 * 60 * 1000),
  });
}

function browserEngineFromEnv(env) {
  const raw = stringFromEnv(env, 'BROWSER_ENGINE', 'camoufox');
  const browser = fingerprintBrowser(raw);
  if (browser) return browser.key;
  const error = new Error(`unsupported BROWSER_ENGINE: ${raw}`);
  error.code = 'BROWSER_ENGINE_UNSUPPORTED';
  throw error;
}

function assertHttpOnlyServiceConfig(env) {
  const transport = String(env.SIGNLIST_CLEAN_TRANSPORT || 'http').toLowerCase();
  const httpsRequested = env.SIGNLIST_CLEAN_ENABLE_HTTPS === '1'
    || Boolean(env.SIGNLIST_CLEAN_HTTPS_PORT)
    || Boolean(env.SIGNLIST_CLEAN_TLS_CERT_FILE)
    || Boolean(env.SIGNLIST_CLEAN_TLS_KEY_FILE)
    || transport === 'https';
  if (httpsRequested) {
    const error = new Error('signlist-clean service is HTTP-only; HTTPS/TLS configuration is not supported');
    error.code = 'HTTP_ONLY_SERVICE';
    throw error;
  }
  if (transport !== 'http') {
    const error = new Error(`unsupported service transport: ${transport}`);
    error.code = 'HTTP_ONLY_SERVICE';
    throw error;
  }
}

function assertProxyDerivedFingerprintConfig(env) {
  const locale = stringFromEnv(env, 'BROWSER_LOCALE', '');
  const geoip = booleanFromEnv(env, 'BROWSER_GEOIP', true);
  const allowExplicitLocale = booleanFromEnv(env, 'BROWSER_ALLOW_EXPLICIT_LOCALE', false);
  if (locale && geoip && !allowExplicitLocale) {
    const error = new Error('BROWSER_LOCALE is disabled by default when BROWSER_GEOIP is enabled; locale/timezone/language must be derived from the proxy IP');
    error.code = 'BROWSER_LOCALE_CONFLICT';
    throw error;
  }
}

function loadConfig(env = process.env) {
  assertHttpOnlyServiceConfig(env);
  assertProxyDerivedFingerprintConfig(env);
  const rootDir = path.resolve(__dirname, '..', '..');
  const locale = stringFromEnv(env, 'BROWSER_LOCALE', '');
  const geoip = booleanFromEnv(env, 'BROWSER_GEOIP', true);
  const allowExplicitLocale = booleanFromEnv(env, 'BROWSER_ALLOW_EXPLICIT_LOCALE', false);
  const dataDir = path.resolve(env.SIGNLIST_CLEAN_DATA_DIR || path.join(rootDir, 'data'));
  return Object.freeze({
    transport: 'http',
    profile: 'registration-only',
    host: env.HOST || '127.0.0.1',
    allowedOrigins: Object.freeze(parseAllowedOrigins(env.SIGNLIST_ALLOWED_ORIGINS || '')),
    port: numberFromEnv(env, 'PORT', 3200, 1, 65535),
    dataDir,
    publicDir: path.join(rootDir, 'public'),
    defaultPassword: env.DEFAULT_REGISTRATION_PASSWORD || '',
    registration: Object.freeze({
      entryBranch: registrationEntryBranchFromEnv(env),
      freepp: freeppRuntimeConfigFromEnv(env, {
        backendFallback: path.join(rootDir, 'vendor', 'freepp', 'backend'),
      }),
    }),
    collector: Object.freeze({
      mode: env.COLLECTOR_MODE || 'full',
      captureBodies: env.COLLECTOR_CAPTURE_BODIES === '1',
      captureRaw: env.COLLECTOR_CAPTURE_RAW === '1',
      maxBodyBytes: numberFromEnv(env, 'COLLECTOR_MAX_BODY_BYTES', 10 * 1024 * 1024, 1024, 100 * 1024 * 1024),
      blockImages: booleanFromEnv(env, 'COLLECTOR_BLOCK_IMAGES', false),
      maxEvents: numberFromEnv(env, 'COLLECTOR_MAX_EVENTS', 20000, 100, 200000),
    }),
    browser: Object.freeze({
      enabled: env.BROWSER_RUN_ENABLED === '1',
      engine: browserEngineFromEnv(env),
      headless: env.BROWSER_HEADLESS || 'virtual',
      chromiumExecutablePath: stringFromEnv(env, 'BROWSER_CHROMIUM_EXECUTABLE_PATH', ''),
      chromiumChannel: stringFromEnv(env, 'BROWSER_CHROMIUM_CHANNEL', ''),
      chromiumMajor: numberFromEnv(env, 'BROWSER_CHROMIUM_MAJOR', 139, 90, 250),
      chromiumUserAgent: stringFromEnv(env, 'BROWSER_CHROMIUM_USER_AGENT', ''),
      cloakCacheDir: path.resolve(stringFromEnv(env, 'CLOAKBROWSER_CACHE_DIR', path.join(dataDir, 'cloak-cache'))),
      cloakProfilesDir: path.resolve(stringFromEnv(env, 'CLOAKBROWSER_PROFILES_DIR', path.join(dataDir, 'cloak-profiles'))),
      cloakReleaseChannel: stringFromEnv(env, 'CLOAKBROWSER_RELEASE_CHANNEL', 'stable'),
      cloakVersion: stringFromEnv(env, 'CLOAKBROWSER_VERSION', '150.0.7871.114.6'),
      os: stringFromEnv(env, 'BROWSER_OS', 'windows'),
      locale,
      geoip,
      localeSource: locale ? 'explicit' : 'proxy_geoip',
      allowExplicitLocale,
      blockWebrtc: booleanFromEnv(env, 'BROWSER_BLOCK_WEBRTC', false),
      blockImages: booleanFromEnv(env, 'BROWSER_BLOCK_IMAGES', true),
      enableCache: booleanFromEnv(env, 'BROWSER_ENABLE_CACHE', true),
      humanize: Number.isFinite(Number(env.BROWSER_HUMANIZE_SECONDS)) ? Number(env.BROWSER_HUMANIZE_SECONDS) : 1.5,
      screen: Object.freeze({
        minWidth: numberFromEnv(env, 'BROWSER_SCREEN_MIN_WIDTH', 1366, 800, 7680),
        maxWidth: numberFromEnv(env, 'BROWSER_SCREEN_MAX_WIDTH', 1920, 800, 7680),
        minHeight: numberFromEnv(env, 'BROWSER_SCREEN_MIN_HEIGHT', 768, 600, 4320),
        maxHeight: numberFromEnv(env, 'BROWSER_SCREEN_MAX_HEIGHT', 1080, 600, 4320),
      }),
      window: Object.freeze([
        numberFromEnv(env, 'BROWSER_WINDOW_WIDTH', 1366, 800, 7680),
        numberFromEnv(env, 'BROWSER_WINDOW_HEIGHT', 768, 600, 4320),
      ]),
      launchTimeoutMs: numberFromEnv(env, 'BROWSER_LAUNCH_TIMEOUT_MS', 60000, 5000, 180000),
      operationTimeoutMs: numberFromEnv(env, 'BROWSER_OPERATION_TIMEOUT_MS', 30000, 5000, 180000),
      maxProxyAttempts: numberFromEnv(env, 'BROWSER_MAX_PROXY_ATTEMPTS', 3, 1, 3),
    }),
    mailbox: Object.freeze({
      pollTimeoutMs: numberFromEnv(env, 'MAILBOX_POLL_TIMEOUT_MS', 120000, 1000, 15 * 60 * 1000),
      pollIntervalMs: numberFromEnv(env, 'MAILBOX_POLL_INTERVAL_MS', 3000, 250, 60000),
      otpPhase1Ms: numberFromEnv(env, 'MAILBOX_OTP_PHASE1_MS', 45000, 1000, 15 * 60 * 1000),
      otpPhase2Ms: numberFromEnv(env, 'MAILBOX_OTP_PHASE2_MS', 60000, 1000, 15 * 60 * 1000),
      cloudflareTempEmail: Object.freeze({
        baseUrl: stringFromEnv(env, 'CLOUDFLARE_TEMP_EMAIL_BASE_URL', stringFromEnv(env, 'CF_TEMP_EMAIL_BASE_URL', '')),
        adminAuth: stringFromEnv(env, 'CLOUDFLARE_TEMP_EMAIL_ADMIN_AUTH', stringFromEnv(env, 'CF_TEMP_EMAIL_ADMIN_AUTH', '')),
        customAuth: stringFromEnv(env, 'CLOUDFLARE_TEMP_EMAIL_CUSTOM_AUTH', stringFromEnv(env, 'CF_TEMP_EMAIL_CUSTOM_AUTH', '')),
        domains: Object.freeze(stringListFromEnv(env, [
          'CLOUDFLARE_TEMP_EMAIL_DOMAINS',
          'CF_TEMP_EMAIL_DOMAINS',
          'CLOUDFLARE_TEMP_EMAIL_DOMAIN',
          'CF_TEMP_EMAIL_DOMAIN',
        ])),
        path: stringFromEnv(env, 'CLOUDFLARE_TEMP_EMAIL_MAILS_PATH', '/admin/mails'),
        limit: numberFromEnv(env, 'CLOUDFLARE_TEMP_EMAIL_MAIL_LIMIT', 30, 1, 200),
      }),
    }),
  });
}

module.exports = {
  loadConfig,
  assertHttpOnlyServiceConfig,
  assertProxyDerivedFingerprintConfig,
  registrationEntryBranchFromEnv,
  browserEngineFromEnv,
};
