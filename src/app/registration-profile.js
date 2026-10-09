'use strict';

const REGISTRATION_CAPABILITIES = Object.freeze({
  registration: true, mailbox: true, proxies: true, credentials: true,
  payment: false, paymentMethodProbe: false, refining: false,
  phoneBind: false, browserRegistration: false,
});

function registrationOnly(config) {
  return config.profile === 'registration-only';
}

function assertRegistrationBranch(config, branch) {
  if (registrationOnly(config) && !['freepp'].includes(branch)) {
    throw Object.assign(new Error('registration-only profile requires a protocol implementation'), {
      code: 'REGISTRATION_IMPLEMENTATION_DISABLED', status: 400, retryableProxy: false,
    });
  }
  return branch;
}

const ROUTES = [
  ['GET', new RegExp("^/api/(config|pipeline-concurrency|accounts|emails|registration-view|proxy-pools)$", '')],
  ['PUT', new RegExp("^/api/preferences$", '')],
  ['GET|PUT', new RegExp("^/api/(registration/change-email/settings|phone-bind/settings|registration/autostart/config)$", '')],
  ['POST', new RegExp("^/api/(registration/autostart/(start|stop)|registration-scratch/clear|mailbox-repairability/recheck)$", '')],
  ['GET|PUT', new RegExp("^/api/mailbox/(cloudflare-temp-email|mail-com-split)/config$", '')],
  ['GET|POST', new RegExp("^/api/mailbox/cloudflare-temp-email/domains$", '')],
  ['POST', new RegExp("^/api/mailbox/cloudflare-temp-email/generate$", '')],
  ['GET|POST', new RegExp("^/api/mailbox/mail-com-split/accounts$", '')],
  ['POST', new RegExp("^/api/mailbox/mail-com-split/(accounts/(import|autostart)|autostart/stop|workflow/reconcile)$", '')],
  ['DELETE', new RegExp("^/api/mailbox/mail-com-split/accounts/[^/]+$", '')],
  ['POST', new RegExp("^/api/mailbox/mail-com-split/accounts/[^/]+/(session/(open|close)|aliases|aliases/sync|domains/sync|mail/clear-inbox)$", '')],
  ['DELETE', new RegExp("^/api/mailbox/mail-com-split/accounts/[^/]+/aliases/[^/]+$", '')],
  ['POST', new RegExp("^/api/mailbox/mail-com-split/accounts/[^/]+/aliases/[^/]+/code$", '')],
  ['GET|POST', new RegExp("^/api/tasks$", '')],
  ['POST', new RegExp("^/api/tasks/(cloudflare-temp-email|mail-com-split)$", '')],
  ['GET', new RegExp("^/api/tasks/[0-9a-f-]+(?:/evidence)?$", 'i')],
  ['POST', new RegExp("^/api/tasks/[0-9a-f-]+/retry$", 'i')],
  ['POST', new RegExp("^/api/emails/(import|delete)$", '')],
  ['DELETE', new RegExp("^/api/emails/[0-9a-f-]+$", 'i')],
  ['DELETE', new RegExp("^/api/accounts/[^/]+/workflow$", 'i')],
  ['GET', new RegExp("^/api/accounts/[^/]+/(login-state|access-token|rt|refresh-token|totp-secret|credential-export)$", 'i')],
  ['POST', new RegExp("^/api/accounts/[^/]+/(credential-repair|eligibility|account-status|access-token/refresh|refresh-token/refresh|session-cookie/renew)$", 'i')],
  ['GET|POST', new RegExp("^/api/(accounts/[^/]+/access-token/live-check|live-check/[^/]+)$", 'i')],
  ['POST', new RegExp("^/api/proxy-pools/(main|eligibility)$", '')],
  ['DELETE', new RegExp("^/api/proxy-pools/(main|eligibility)/[a-z0-9_-]+$", 'i')],
  ['GET|POST', new RegExp("^/api/proxy-pools/(main|eligibility)/[a-z0-9_-]+/proxies$", 'i')],
  ['GET|POST', new RegExp("^/api/proxies/(main|eligibility)$", '')],
];

function registrationApiAllowed(method, pathname) {
  return ROUTES.some(([methods, pattern]) => methods.split('|').includes(method) && pattern.test(pathname));
}

function registrationCatalog(catalog) {
  return {
    ...catalog,
    types: catalog.types.filter((type) => type.key === 'protocol'),
    implementations: catalog.implementations.filter((entry) => entry.type === 'protocol'),
    fingerprintBrowsers: [],
  };
}

module.exports = { REGISTRATION_CAPABILITIES, registrationOnly, assertRegistrationBranch, registrationApiAllowed, registrationCatalog };
