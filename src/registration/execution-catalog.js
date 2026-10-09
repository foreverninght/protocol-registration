'use strict';

const EXECUTION_TYPES = Object.freeze([
  Object.freeze({ id: 1, key: 'browser', label: '浏览器', usesFingerprintBrowser: true }),
  Object.freeze({ id: 2, key: 'hybrid', label: '半协议', usesFingerprintBrowser: true }),
  Object.freeze({ id: 3, key: 'protocol', label: '协议', usesFingerprintBrowser: false }),
]);

const FINGERPRINT_BROWSERS = Object.freeze([
  Object.freeze({ id: 1, key: 'cloak', label: 'CloakBrowser' }),
  Object.freeze({ id: 2, key: 'chromium', label: 'Chromium' }),
  Object.freeze({ id: 3, key: 'camoufox', label: 'Camoufox' }),
]);

const EXECUTION_IMPLEMENTATIONS = Object.freeze([
  Object.freeze({ id: 101, key: 'flowpilot', type: 'browser', label: 'FlowPilot' }),
  // Browser implementation id 102 (direct) is retired and must not be reused.
  Object.freeze({ id: 201, key: 'context_protocol', type: 'hybrid', label: '浏览器上下文协议' }),
  Object.freeze({ id: 301, key: 'freepp', type: 'protocol', label: 'FreePP' }),
]);

const IMPLEMENTATION_ALIASES = Object.freeze({
  current: 'flowpilot',
  legacy: 'flowpilot',
  auth: 'flowpilot',
  signin: 'flowpilot',
  direct: 'flowpilot',
  flow: 'flowpilot',
});

const FINGERPRINT_BROWSER_ALIASES = Object.freeze({
  firefox: 'camoufox',
  chrome: 'chromium',
  googlechrome: 'chromium',
  cloakbrowser: 'cloak',
});

function findByIdOrKey(items, value, aliases = {}) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  const key = aliases[text] || text;
  return items.find((item) => item.key === key || String(item.id) === text) || null;
}

function executionType(value) {
  return findByIdOrKey(EXECUTION_TYPES, value);
}

function executionImplementation(value) {
  return findByIdOrKey(EXECUTION_IMPLEMENTATIONS, value, IMPLEMENTATION_ALIASES);
}

function fingerprintBrowser(value) {
  return findByIdOrKey(FINGERPRINT_BROWSERS, value, FINGERPRINT_BROWSER_ALIASES);
}

function executionTypeForImplementation(value) {
  const implementation = executionImplementation(value);
  return implementation ? executionType(implementation.type) : null;
}

function usesFingerprintBrowser(value) {
  return Boolean(executionTypeForImplementation(value)?.usesFingerprintBrowser);
}

function publicExecutionCatalog() {
  return {
    types: EXECUTION_TYPES.map((item) => ({ ...item })),
    implementations: EXECUTION_IMPLEMENTATIONS.map((item) => ({ ...item })),
    fingerprintBrowsers: FINGERPRINT_BROWSERS.map((item) => ({ ...item })),
  };
}

module.exports = {
  EXECUTION_TYPES,
  EXECUTION_IMPLEMENTATIONS,
  FINGERPRINT_BROWSERS,
  executionType,
  executionImplementation,
  executionTypeForImplementation,
  fingerprintBrowser,
  usesFingerprintBrowser,
  publicExecutionCatalog,
};
