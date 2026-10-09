'use strict';

const path = require('node:path');
const { assertRegistrationBranch } = require('../app/registration-profile');

const { EvidenceStore } = require('../collector/storage/evidence-store');
const { FullNetworkCollector } = require('../collector/network/full-network-collector');
const { capturePageSnapshot } = require('../collector/artifacts/page-snapshot');
const { createFingerprintBrowserSession } = require('../browser/lifecycle/fingerprint-browser');
const { openChatgptHome } = require('./steps/open-chatgpt');
const { openFlowPilotEmailEntry } = require('./steps/flowpilot-email-entry');
const { openContextProtocolEmailEntry } = require('./steps/context-protocol-email-entry');
const { submitCreatePasswordBeforeOtp } = require('./steps/submit-create-password');
const { submitOtp } = require('./steps/submit-otp');
const { submitProfile } = require('./steps/submit-profile');
const { finalizeSession, maybeFinalizeSession } = require('./steps/finalize-session');
const { findSessionCookie } = require('./session-cookies');
const {
  collectPostRegistrationBootstrap,
  publicPostRegistrationBootstrapResult,
} = require('./post-registration-bootstrap');
const { waitForVerificationCode, waitForVerificationCodeWithResends } = require('../mailbox/mailbox-poller');
const { createSharePageMailboxProvider } = require('../mailbox/providers/share-page-provider');
const { createIcmailPublicProvider, parseIcmailPublicUrl } = require('../mailbox/providers/icmail-public');
const {
  createIcloudSheexMailboxProvider,
  parseIcloudSheexMailboxUrl,
} = require('../mailbox/providers/icloud-sheex');
const {
  cloudflareTempEmailConfigured,
  createCloudflareTempEmailProvider,
  domainMatchesEmail,
} = require('../mailbox/providers/cloudflare-temp-email');
const {
  createMailComSplitProvider,
  releaseMailComSplitAddress,
} = require('../mailbox/providers/mail-com-split');
const { assertProxyQuality, expectedCountryFromPool } = require('../proxies/proxy-geo-preflight');
const { browserEngineFromEnv, registrationEntryBranchFromEnv } = require('../app/config');
const { setupTotp2fa } = require('../security/totp-2fa');
const { analyzeTrialEligibility } = require('../eligibility/trial-eligibility');
const { runFreeppRegistration, runFreeppCredentialRepair } = require('./freepp-sidecar-runner');
const { hasUsableOauthSession } = require('../session/account-login-state');
const {
  executionTypeForImplementation,
  usesFingerprintBrowser,
} = require('./execution-catalog');

class RegistrationPasswordBranchError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RegistrationPasswordBranchError';
    this.code = 'REGISTRATION_PASSWORD_BRANCH_REACHED';
    this.retryableProxy = false;
    this.details = details;
  }
}

function shouldQuarantineProxy(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (/^PROXY_/.test(code)) return true;
  if ([
    'FLOWPILOT_SECURITY_CHALLENGE',
    'CHATGPT_HOME_HTTP_ERROR',
  ].includes(code)) return true;
  const message = String(error?.message || error || '').toLowerCase();
  return /socket hang up|econnreset|proxy.*(?:connect|tunnel|timeout)|http\s+403/.test(message);
}

async function savePageSnapshot({ page, evidence, update, label, step, error, extra }) {
  if (!page) return null;
  const snapshot = await capturePageSnapshot({ page, evidence, label, error });
  if (!snapshot) return null;
  update({
    type: 'browser.page_snapshot_saved',
    step: step || 'page_snapshot_saved',
    ...(extra || {}),
    snapshot: {
      label: snapshot.label,
      url: snapshot.url,
      title: snapshot.title,
      html: snapshot.html,
      screenshot: snapshot.screenshot,
      visible: snapshot.visible,
    },
  });
  return snapshot;
}

function freeppSessionCookies(sessionToken, sessionContext = {}) {
  const cookies = [];
  const seen = new Set();
  const add = (cookie) => {
    if (!cookie?.name || !cookie?.value) return;
    const key = `${String(cookie.domain || '').replace(/^\./u, '').toLowerCase()}|${cookie.path || '/'}|${cookie.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    cookies.push(cookie);
  };
  for (const cookie of parseCookieHeader(sessionContext.cookie, 'chatgpt.com')) add(cookie);
  const token = String(sessionToken || '').trim();
  const hasSessionTokenCookie = cookies.some((cookie) => /next-auth\.session-token/u.test(String(cookie.name || '')));
  if (token && !hasSessionTokenCookie) {
    add({
      name: '__Secure-next-auth.session-token',
      value: token,
      domain: '.chatgpt.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
  }
  return cookies;
}

function parseCookieHeader(header, domain) {
  const text = String(header || '').trim();
  const pairs = [];
  if (text.startsWith('{') && text.endsWith('}')) {
    const pattern = /['"]([^'"]+)['"]\s*:\s*['"]((?:\\.|[^'"])*)['"]/g;
    for (const match of text.matchAll(pattern)) pairs.push([match[1], match[2]]);
  } else {
    for (const part of text.split(';')) {
      const separator = part.indexOf('=');
      if (separator > 0) pairs.push([
        part.slice(0, separator).trim(),
        part.slice(separator + 1).trim(),
      ]);
    }
  }
  return pairs
    .map(([name, value]) => ({
      name,
      value,
      domain: String(domain || '').trim() || undefined,
      path: '/',
      httpOnly: true,
      secure: true,
    }))
    .filter((cookie) => cookie.name && cookie.value);
}

function freeppOauthSession(rawSession, { capturedAt, taskId } = {}) {
  if (!rawSession || typeof rawSession !== 'object') return null;
  const cookies = Array.isArray(rawSession.cookies)
    ? rawSession.cookies
      .filter((cookie) => cookie && typeof cookie === 'object' && cookie.name && cookie.value)
      .map((cookie) => ({ ...cookie }))
    : [];
  const cookie = String(rawSession.cookie || '').trim();
  const cookieHeaders = rawSession.cookie_headers && typeof rawSession.cookie_headers === 'object'
    ? Object.fromEntries(Object.entries(rawSession.cookie_headers)
      .map(([host, value]) => [host, String(value || '').trim()])
      .filter(([, value]) => value))
    : {};
  const cookieSources = [
    ...cookies,
    ...Object.entries(cookieHeaders).flatMap(([host, value]) => parseCookieHeader(value, host)),
    ...parseCookieHeader(cookie, 'auth.openai.com'),
  ];
  const normalizedCookies = [];
  const seenCookies = new Set();
  for (const item of cookieSources) {
    const key = `${item.domain || ''}|${item.path || '/'}|${item.name}`;
    if (seenCookies.has(key)) continue;
    seenCookies.add(key);
    normalizedCookies.push(item);
  }
  if (!cookies.length && !cookie && !Object.keys(cookieHeaders).length) return null;
  return {
    cookies: normalizedCookies,
    ...(cookie ? { cookie } : {}),
    ...(Object.keys(cookieHeaders).length ? { cookieHeaders } : {}),
    ...(rawSession.user_agent ? { userAgent: String(rawSession.user_agent) } : {}),
    ...(Array.isArray(rawSession.hosts) ? { hosts: rawSession.hosts.map((host) => String(host)).filter(Boolean) } : {}),
    capturedAt,
    sourceTaskId: taskId,
    source: 'freepp_oauth',
  };
}

function successfulFreeppOauthQualification(probe) {
  if (!probe || typeof probe !== 'object') return false;
  const selectStatus = Number(probe.sessionSelectStatus || 0);
  return Boolean(
    probe.ok
      || (probe.accountSelectSessionAvailable
        && probe.addPhoneUrlAvailable
        && selectStatus >= 200
        && selectStatus < 300),
  );
}

function isProtocolEntryBranch(branch) {
  return executionTypeForImplementation(branch)?.key === 'protocol';
}

const isFreeppSidecarEntryBranch = isProtocolEntryBranch;

function trialEligibilityStatus(trialEligibility) {
  return String(trialEligibility?.status || '').trim().toLowerCase();
}

function assertNoCompletionError(result = {}) {
  if (!result.completionError) return;
  const detail = result.completionError;
  const error = new Error(String(detail.message || detail.code || 'registration completion failed'));
  error.code = detail.code || 'REGISTRATION_COMPLETION_FAILED';
  error.retryableProxy = false;
  error.details = detail;
  throw error;
}

function assertConfiguredRegistrationCompletion({
  registrationExtras = {},
  freeppResult = {},
  oauthSession = null,
  oauthQualified = false,
  trialEligibility = null,
} = {}) {
  assertNoCompletionError(freeppResult);
  const missing = [];
  if (registrationExtras.setupPassword === true && freeppResult.passwordStatus !== 'has_password') {
    missing.push({
      code: freeppResult.passwordError?.code || 'REGISTRATION_PASSWORD_REQUIRED',
      label: 'password',
      message: freeppResult.passwordError?.message || '已开启“注册完成后创建密码”，但密码没有创建成功。',
    });
  }
  if (registrationExtras.setupTotp2fa === true && (!freeppResult.totpSecret || freeppResult.totpVerified === false)) {
    missing.push({
      code: freeppResult.totpError?.code || 'REGISTRATION_TOTP_REQUIRED',
      label: '2fa',
      message: freeppResult.totpError?.message || '已开启“注册完成后设置 2FA”，但 2FA 没有设置成功。',
    });
  }
  if (registrationExtras.validateOauthSession === true && !hasUsableOauthSession(oauthSession)) {
    missing.push({
      code: 'REGISTRATION_LOGIN_STATE_REQUIRED',
      label: 'login_state',
      message: '已开启“注册后验证登录态”，但 OAuth/session 登录态不可用。',
    });
  }
  if (registrationExtras.phoneBindProbeEnabled === true && !oauthQualified) {
    missing.push({
      code: 'REGISTRATION_PHONE_BIND_ENTRY_REQUIRED',
      label: 'phone_bind_entry',
      message: '已开启“注册后验证接码入口”，但没有成功进入接码入口。',
    });
  }
  if (!missing.length) return { ok: true, missing: [] };
  const error = new Error(missing.map((item) => item.message).join('；'));
  error.code = missing.some((item) => item.label === 'eligibility')
    ? 'REGISTRATION_NOT_ELIGIBLE'
    : 'REGISTRATION_POST_STEPS_INCOMPLETE';
  error.retryableProxy = false;
  error.details = { missing };
  throw error;
}

class RegistrationRunner {
  constructor({
    config,
    registrationStore,
    accountAssetStore,
    mailboxStore,
    proxyPools,
    runtimeStateStore,
    mailboxSettings = null,
    phoneBindSettings = null,
    changeEmailSettings = null,
    paymentMethodProbeScheduler = null,
    workerId = `registration-runner:${process.pid}`,
    leaseMs = 300000,
    freeppRegistrationRunner = runFreeppRegistration,
    freeppCredentialRepairRunner = runFreeppCredentialRepair,
    proxyQualityChecker = assertProxyQuality,
    mailComAddressReleaser = releaseMailComSplitAddress,
  }) {
    if (!registrationStore || !accountAssetStore || !mailboxStore || !runtimeStateStore) {
      throw new TypeError('registrationStore, accountAssetStore, mailboxStore, and runtimeStateStore are required');
    }
    this.config = config;
    this.registrationStore = registrationStore;
    this.accountAssetStore = accountAssetStore;
    this.mailboxStore = mailboxStore;
    this.proxyPools = proxyPools;
    this.runtimeStateStore = runtimeStateStore;
    this.mailboxSettings = mailboxSettings;
    this.phoneBindSettings = phoneBindSettings;
    this.paymentMethodProbeScheduler = typeof paymentMethodProbeScheduler === 'function' ? paymentMethodProbeScheduler : null;
    this.changeEmailSettings = changeEmailSettings;
    this.workerId = String(workerId || '').trim();
    if (!this.workerId) throw new TypeError('registration runner workerId is required');
    this.leaseMs = Math.max(30000, Math.min(3600000, Math.trunc(Number(leaseMs) || 300000)));
    this.freeppRegistrationRunner = freeppRegistrationRunner;
    this.freeppCredentialRepairRunner = freeppCredentialRepairRunner;
    this.proxyQualityChecker = proxyQualityChecker;
    this.mailComAddressReleaser = mailComAddressReleaser;
    this.running = new Set();
  }

  browserConfigForTask(task) {
    const rawEngine = String(task?.browserEngine || '').trim();
    if (!rawEngine) return this.config;
    const engine = browserEngineFromEnv({ BROWSER_ENGINE: rawEngine });
    return {
      ...this.config,
      browser: Object.freeze({
        ...this.config.browser,
        engine,
      }),
    };
  }

  entryBranchForTask(task) {
    const rawBranch = String(task?.entryBranch || '').trim();
    if (!rawBranch) return this.config.registration?.entryBranch || 'freepp';
    return registrationEntryBranchFromEnv({ REGISTRATION_ENTRY_BRANCH: rawBranch });
  }

  async mailboxProviderForTask(task) {
    if (task.mailboxUrl) {
      if (parseIcmailPublicUrl(task.mailboxUrl)) {
        return {
          provider: createIcmailPublicProvider({ inboxUrl: task.mailboxUrl }),
          source: 'icmail_public',
        };
      }
      if (parseIcloudSheexMailboxUrl(task.mailboxUrl)) {
        return {
          provider: createIcloudSheexMailboxProvider({ shareUrl: task.mailboxUrl }),
          source: 'icloud_sheex',
        };
      }
      return {
        provider: createSharePageMailboxProvider({ shareUrl: task.mailboxUrl }),
        source: 'share_page',
      };
    }
    if (task.mailboxSource === 'mail_com_split') {
      const ownershipError = (message) => {
        const error = new Error(message);
        error.code = 'MAIL_COM_TASK_OWNERSHIP_INVALID';
        error.retryableProxy = false;
        return error;
      };
      if (!task.mailboxId || !task.aliasId || !task.accountId) {
        throw ownershipError('mail.com split task ownership is incomplete');
      }
      const [mailbox, alias] = await Promise.all([
        this.mailboxStore.getMailbox({ mailboxId: task.mailboxId, includeSecret: true }),
        this.mailboxStore.getAlias({ aliasId: task.aliasId }),
      ]);
      if (!mailbox || mailbox.provider !== 'mail_com') throw ownershipError('task main mailbox does not exist');
      if (!alias
        || alias.mailboxId !== mailbox.id
        || alias.accountId !== task.accountId
        || alias.email !== String(task.email || '').trim().toLowerCase()
        || alias.status !== 'registering') {
        throw ownershipError('task alias is not registered to its account and main mailbox');
      }
      return {
        provider: createMailComSplitProvider({ mailboxStore: this.mailboxStore, mailbox, alias }),
        source: 'mail_com_split',
      };
    }
    const cloudflareConfig = this.mailboxSettings?.getSecretConfig?.() || this.config.mailbox?.cloudflareTempEmail;
    if (cloudflareTempEmailConfigured(cloudflareConfig) && domainMatchesEmail(task.email, cloudflareConfig.domains)) {
      return {
        provider: createCloudflareTempEmailProvider(cloudflareConfig),
        source: 'cloudflare_temp_email',
      };
    }
    return { provider: null, source: 'none' };
  }

  async saveCommittedRegistrationProgress(input) {
    try {
      return await this.accountAssetStore.saveProgress(input);
    } catch (error) {
      error.retryableProxy = false;
      throw error;
    }
  }

  async finishRegistration(input) {
    try {
      return await this.accountAssetStore.completeRegistration(input);
    } catch (error) {
      error.retryableProxy = false;
      throw error;
    }
  }

  async assertTaskLease(task) {
    if (task.leaseSignal?.aborted) throw task.leaseSignal.reason;
    if (task.leaseGuard) {
      try {
        await this.registrationStore.assertLease?.({ jobId: task.id, guard: task.leaseGuard });
      } catch (error) {
        throw task.onLeaseLost ? task.onLeaseLost(error) : error;
      }
    }
  }

  async releaseTerminalMailComAlias(task, update) {
    if (task.mailboxSource !== 'mail_com_split' || !task.aliasId) return { action: 'skipped' };
    await this.assertTaskLease(task);
    let released;
    try {
      released = await this.mailComAddressReleaser({
        mailboxStore: this.mailboxStore,
        mailboxId: task.mailboxId,
        aliasId: task.aliasId,
        accountId: task.accountId,
        email: task.email,
        timeoutMs: 60000,
      });
    } catch (error) {
      try {
        await this.assertTaskLease(task);
        const result = await this.mailboxStore.markAliasCleanupRequired({
          aliasId: task.aliasId,
          error,
        });
        await update({
          type: 'mail_com.alias_cleanup_required',
          result,
          error: {
            code: error?.code || 'MAIL_COM_ALIAS_RELEASE_FAILED',
            message: String(error?.message || error),
          },
        });
        return { action: 'cleanup_required', error, result };
      } catch (transitionError) {
        await update({
          type: 'mail_com.alias_cleanup_transition_failed',
          error: {
            code: transitionError?.code || 'MAIL_COM_ALIAS_CLEANUP_TRANSITION_FAILED',
            message: String(transitionError?.message || transitionError),
          },
          releaseError: {
            code: error?.code || 'MAIL_COM_ALIAS_RELEASE_FAILED',
            message: String(error?.message || error),
          },
        });
        return { action: 'transition_failed', error, transitionError };
      }
    }
    await update({
      type: 'mail_com.alias_released',
      result: released,
    });
    return { action: 'released', result: released };
  }

  async recordTerminalMailComDomainResult(task, { ok = false, error = null, trialEligibility = null } = {}) {
    if (task.mailboxSource !== 'mail_com_split') return null;
    const email = String(task.email || '').trim().toLowerCase();
    const separator = email.lastIndexOf('@');
    const domain = separator >= 0 ? email.slice(separator + 1) : '';
    if (!domain) return null;
    const errorCode = String(error?.code || '').trim().toUpperCase();
    const trialStatus = trialEligibilityStatus(trialEligibility);
    const failureKind = trialStatus === 'not_eligible'
      ? 'not_eligible'
      : (!ok && errorCode === 'MAILBOX_CODE_TIMEOUT'
      ? 'otp_timeout'
      : (!ok && (errorCode === 'REGISTRATION_NOT_ELIGIBLE'
        || error?.details?.missing?.some((item) => item?.label === 'eligibility'))
        ? 'not_eligible'
        : String(error?.code || '').trim().toLowerCase()));
    const evidenceOk = ok && trialStatus !== 'not_eligible';
    await this.assertTaskLease(task);
    return this.mailboxStore.recordMailComDomainRegistrationResult({
      domain,
      jobId: task.id,
      ok: evidenceOk,
      failureKind,
      error,
    });
  }

  async transitionTerminalMailComWorkflow(task, {
    release,
    trialEligibility = null,
    registrationFailed = false,
  } = {}) {
    await this.assertTaskLease(task);
    if (task.mailboxSource !== 'mail_com_split') {
      if (registrationFailed) return null;
      const account = await this.accountAssetStore.getByJob(task.id, { includeSecret: true });
      const trialStatus = String(
        trialEligibility?.status
        || account?.trialEligibility?.status
        || account?.eligibilityStatus
        || 'unknown',
      ).trim().toLowerCase();
      const nextStage = trialStatus === 'eligible' ? 'payment_method' : 'eligibility';
      const transition = await this.accountAssetStore.transitionWorkflow({ jobId: task.id, stage: nextStage, ...(task.leaseGuard ? { guard: task.leaseGuard } : {}) });
      if (trialStatus === 'eligible' && this.paymentMethodProbeScheduler) {
        try {
          await this.paymentMethodProbeScheduler(task.email);
        } catch (error) {
          this.accountAssetStore.updateByEmail?.({ email: task.email, ...(task.leaseGuard ? { guard: task.leaseGuard } : {}), patch: { paymentMethodProbeError: { code: error?.code || 'PAYMENT_METHOD_PROBE_SCHEDULE_FAILED', message: String(error?.message || error).slice(0, 500), at: new Date().toISOString() } } }).catch(() => {});
        }
      }
      return transition;
    }
    if (registrationFailed) {
      return this.accountAssetStore.transitionMailComWorkflow({
        ...(task.leaseGuard ? { guard: task.leaseGuard } : {}),
        jobId: task.id,
        stage: 'unregistered',
        releaseStatus: release?.action === 'released' ? 'released' : 'cleanup_required',
        releaseError: release?.error || null,
        discard: true,
        discardReason: 'registration_failed',
      });
    }
    if (release?.action !== 'released') {
      return this.accountAssetStore.transitionMailComWorkflow({
        ...(task.leaseGuard ? { guard: task.leaseGuard } : {}),
        jobId: task.id,
        stage: 'unregistered',
        releaseStatus: 'cleanup_required',
        releaseError: release?.error || null,
      });
    }
    const account = await this.accountAssetStore.getByJob(task.id, { includeSecret: true });
    const trialStatus = String(
      trialEligibility?.status
      || account?.trialEligibility?.status
      || account?.eligibilityStatus
      || 'unknown',
    ).trim().toLowerCase();
      if (trialStatus === 'not_eligible') {
        return this.accountAssetStore.transitionMailComWorkflow({
          ...(task.leaseGuard ? { guard: task.leaseGuard } : {}),
          jobId: task.id,
          stage: 'eligibility',
          releaseStatus: 'released',
          releaseError: null,
        });
      }
      const paymentStage = await this.accountAssetStore.transitionMailComWorkflow({
        ...(task.leaseGuard ? { guard: task.leaseGuard } : {}),
        jobId: task.id,
        stage: trialStatus === 'eligible' ? 'payment_method' : 'eligibility',
        releaseStatus: 'released',
        releaseError: null,
      });
      if (trialStatus === 'eligible' && this.paymentMethodProbeScheduler) {
        try {
          await this.paymentMethodProbeScheduler(task.email);
        } catch (error) {
          this.accountAssetStore.updateByEmail?.({ email: task.email, ...(task.leaseGuard ? { guard: task.leaseGuard } : {}), patch: { paymentMethodProbeError: { code: error?.code || 'PAYMENT_METHOD_PROBE_SCHEDULE_FAILED', message: String(error?.message || error).slice(0, 500), at: new Date().toISOString() } } }).catch(() => {});
        }
      }
      return paymentStage;
    }

  async reconcileTerminalMailComAliases({ mailboxId = '', remoteAliasEmails = null } = {}) {
    const aliases = await this.mailboxStore.listAliases({
      mailboxId,
      statuses: ['cleanup_required', 'abandoned'],
    });
    const observedRemoteAliases = Array.isArray(remoteAliasEmails)
      ? new Set(remoteAliasEmails.map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))
      : null;
    const results = [];
    for (const alias of aliases) {
      const confirmedAbsent = alias.status === 'cleanup_required'
        && observedRemoteAliases
        && !observedRemoteAliases.has(alias.email);
      if (confirmedAbsent && (!alias.latestJobId || !alias.accountId)) {
        await this.mailboxStore.markAliasAbandoned({ aliasId: alias.id });
        results.push({
          aliasId: alias.id,
          email: alias.email,
          action: 'released',
          evidence: 'remote_snapshot',
        });
        continue;
      }
      if (!alias.latestJobId || !alias.accountId) {
        results.push({ aliasId: alias.id, email: alias.email, action: 'invalid_ownership' });
        continue;
      }
      const task = await this.registrationStore.loadJob({ jobId: alias.latestJobId });
      if (!task || !['completed', 'failed', 'cancelled', 'blocked'].includes(task.status)) {
        results.push({ aliasId: alias.id, email: alias.email, action: 'job_not_terminal' });
        continue;
      }
      const update = (event) => this.registrationStore.appendEvent({ jobId: task.id, event });
      if (alias.status === 'abandoned') {
        const account = await this.accountAssetStore.getByJob(task.id, { includeSecret: true });
        if (account?.mailComReleaseStatus === 'released') {
          results.push({ aliasId: alias.id, email: alias.email, action: 'already_reconciled' });
          continue;
        }
        const release = { action: 'released', result: { alias } };
        await this.transitionTerminalMailComWorkflow(task, {
          release,
          registrationFailed: task.status !== 'completed',
        });
        await update({
          type: 'mail_com.alias_release_reconciled_from_local_state',
          result: release.result,
        });
        results.push({ aliasId: alias.id, email: alias.email, action: 'released' });
        continue;
      }
      let release;
      if (confirmedAbsent) {
        const result = await this.mailboxStore.markAliasAbandoned({ aliasId: alias.id });
        await update({
          type: 'mail_com.alias_release_confirmed_by_snapshot',
          result,
        });
        release = { action: 'released', result };
      } else {
        release = await this.releaseTerminalMailComAlias(task, update);
      }
      if (release.action === 'released') {
        await this.transitionTerminalMailComWorkflow(task, {
          release,
          registrationFailed: task.status !== 'completed',
        });
      }
      results.push({ aliasId: alias.id, email: alias.email, action: release.action });
    }
    return results;
  }

  async runCredentialRepair(task, { update, flushEvents, signal } = {}) {
    const account = await this.accountAssetStore.getByEmail(task.email, { includeSecret: true });
    const accessTokenAvailable = Boolean(String(account?.tokens?.accessToken || '').trim());
    const hasRegistrationEvidence = Boolean(
      account
      && (account.status === 'registered' || account.registrationCreated === true || accessTokenAvailable || account.sessionAvailable
        || ['FREEPP_FINAL_AT_VALIDATION_FAILED', 'FREEPP_CHANGE_EMAIL_FAILED'].includes(account.completionError?.code))
    );
    if (!hasRegistrationEvidence) {
      const error = new Error('credential repair requires an already registered account or persisted login assets');
      error.code = 'CREDENTIAL_REPAIR_ACCOUNT_NOT_REGISTERED';
      error.retryableProxy = false;
      throw error;
    }
    const repairPassword = account.passwordStatus !== 'has_password';
    const repairTotp = account.totpStatus !== 'enabled';
    if (!repairPassword && !repairTotp && accessTokenAvailable && account.sessionAvailable
      && account.finalAtValidation?.status !== 'invalid' && !account.completionError) {
      update({ type: 'credential_repair.completed', status: 'succeeded', step: 'completed', result: { alreadyComplete: true } });
      await flushEvents();
      return;
    }
    update({
      type: 'credential_repair.started',
      status: 'running',
      step: 'credential_repair_starting',
      repairPassword,
      repairTotp,
    });
    const poolId = task.proxyPoolId || undefined;
    const pool = poolId ? this.proxyPools.main.listPools().find((item) => item.id === poolId) : null;
    const expectedCountry = expectedCountryFromPool(pool);
    const attempted = new Set();
    let lastError = null;
    for (let attempt = 1; attempt <= this.config.browser.maxProxyAttempts; attempt += 1) {
      await this.assertTaskLease(task);
      const proxy = await this.proxyPools.main.pickNext({ poolId, excludeIds: [...attempted] });
      if (!proxy) break;
      attempted.add(proxy.id);
      try {
        const preflight = await this.proxyQualityChecker(proxy, { expectedCountry, timeoutMs: 10000, maxLatencyMs: 15000 });
        await this.assertTaskLease(task);
        await this.proxyPools.main.markChecked?.(proxy.id, {
          poolId: proxy.poolId || poolId,
          latencyMs: preflight.geo?.latencyMs ?? null,
          country: preflight.geo?.countryCode || null,
        });
        update({
          type: 'credential_repair.proxy_selected',
          status: 'running',
          step: 'credential_repair_proxy_selected',
          proxyAttempt: attempt,
          proxy: { id: proxy.id, country: proxy.country, host: proxy.host, port: proxy.port },
        });
        const mailbox = await this.mailboxProviderForTask(task);
        await this.assertTaskLease(task);
        const result = await this.freeppCredentialRepairRunner({
          signal,
          config: this.config,
          task,
          proxy,
          mailbox,
          account,
          entryBranch: 'freepp',
          update,
          startedAt: Date.now(),
        });
        await flushEvents();
        await this.assertTaskLease(task);
        const completionError = result.completionError
          || (account.completionError?.code === 'FREEPP_CHANGE_EMAIL_FAILED' ? account.completionError : null);
        const passwordReady = repairPassword ? result.passwordStatus === 'has_password' : account.passwordStatus === 'has_password';
        const totpReady = repairTotp ? Boolean((result.totpSecret || result.totpActiveFactorId) && result.totpVerified !== false) : account.totpStatus === 'enabled';
        const accessToken = result.accessToken || account.tokens?.accessToken || '';
        const accessTokenReady = Boolean(accessToken && result.finalAtValidation?.status === 'valid');
        const sessionContext = Object.keys(result.sessionContext || {}).length ? result.sessionContext : account.sessionContext;
        const sessionReady = Boolean(account.sessionAvailable || sessionContext?.cookie || result.sessionToken);
        const repairedCookies = freeppSessionCookies(result.sessionToken, result.sessionContext || {});
        if (completionError || !passwordReady || !totpReady || !accessTokenReady || !sessionReady) {
          const partialPatch = {
            ...(completionError ? { completionError } : {}),
            ...(result.finalAtValidation ? { finalAtValidation: result.finalAtValidation } : {}),
          };
          const partialUpdatedAt = new Date().toISOString();
          if (repairPassword && passwordReady) {
            Object.assign(partialPatch, {
              password: result.password || account.password || task.registrationPassword,
              passwordStatus: 'has_password',
              passwordStatusSource: 'credential_repair',
              passwordStatusUpdatedAt: partialUpdatedAt,
            });
          }
          if (repairTotp && (result.totpSecret || result.totpActiveFactorId)) {
            Object.assign(partialPatch, {
              hasTotp: totpReady,
              totpStatus: totpReady ? 'enabled' : 'failed',
              totpVerified: result.totpVerified,
              totpActivated: result.totpActivated,
              totpSecret: result.totpSecret || account.totpSecret,
              totpActiveFactorId: result.totpActiveFactorId || account.totpActiveFactorId,
              totpEnrollmentSessionId: result.totpEnrollmentSessionId || account.totpEnrollmentSessionId,
              totpSetupAt: partialUpdatedAt,
              totpSetupError: result.totpError || null,
            });
          }
          if (accessTokenReady && (result.accessToken || Object.keys(result.tokenJson || {}).length)) {
            partialPatch.tokens = { ...(account.tokens || {}), ...(result.tokenJson || {}), accessToken };
          }
          if (result.sessionToken || result.refreshToken) {
            partialPatch.tokens = {
              ...(account.tokens || {}), ...(partialPatch.tokens || {}),
              ...(result.sessionToken ? { sessionToken: result.sessionToken } : {}),
              ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
            };
          }
          if (Object.keys(result.sessionContext || {}).length || result.sessionToken) {
            partialPatch.sessionAvailable = sessionReady;
            partialPatch.sessionContext = sessionContext;
            const cookies = freeppSessionCookies(result.sessionToken, result.sessionContext || {});
            if (cookies.length) partialPatch.session = { cookies, capturedAt: partialUpdatedAt, sourceTaskId: task.id };
          }
          if (result.oauthSession) partialPatch.oauthSession = result.oauthSession;
          if (Object.keys(partialPatch).length) {
            await this.accountAssetStore.updateByEmail({ email: account.email, patch: partialPatch, guard: task.leaseGuard });
          }
          assertNoCompletionError({ completionError });
          const error = new Error('credential repair did not produce complete password, 2FA, access token, and login session assets');
          error.code = 'CREDENTIAL_REPAIR_INCOMPLETE';
          error.retryableProxy = false;
          error.details = { passwordReady, totpReady, accessTokenReady, sessionReady };
          throw error;
        }
        const eligibility = String(account.eligibilityStatus || '').toLowerCase();
        const workflowStage = eligibility === 'not_eligible' ? 'discarded' : 'eligibility';
        const completedAt = new Date().toISOString();
        await this.accountAssetStore.updateByEmail({
          email: account.email,
          ...(task.leaseGuard ? { guard: task.leaseGuard } : {}),
          patch: {
            password: result.password || account.password || task.registrationPassword,
            passwordStatus: 'has_password',
            passwordStatusSource: 'credential_repair',
            passwordStatusUpdatedAt: completedAt,
            hasTotp: true,
            totpStatus: 'enabled',
            totpVerified: repairTotp ? result.totpVerified !== false : account.totpVerified,
            totpSecret: result.totpSecret || account.totpSecret,
            totpActiveFactorId: result.totpActiveFactorId || account.totpActiveFactorId,
              totpEnrollmentSessionId: result.totpEnrollmentSessionId || account.totpEnrollmentSessionId,
            totpSetupAt: completedAt,
            totpSetupError: null,
            tokens: {
              ...(account.tokens || {}), ...(result.tokenJson || {}), accessToken,
              ...(result.sessionToken ? { sessionToken: result.sessionToken } : {}),
              ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
            },
            session: repairedCookies.length
              ? { cookies: repairedCookies, capturedAt: completedAt, sourceTaskId: task.id }
              : account.session,
            sessionAvailable: sessionReady,
            sessionContext,
            oauthSession: result.oauthSession || account.oauthSession,
            workflowStage,
            mailComStage: workflowStage,
            ...(account.registrationCreated === true && ['created', 'registering', 'abandoned'].includes(account.lifecycleStage)
              ? { status: 'registered', lifecycleStage: 'registered' } : {}),
            completionError: null,
            finalAtValidation: result.finalAtValidation,
            credentialRepair: { status: 'completed', taskId: task.id, completedAt },
          },
        });
        update({
          type: 'credential_repair.completed',
          status: 'succeeded',
          step: 'completed',
          result: { passwordReady, totpReady, accessTokenReady: true, sessionReady: true },
        });
        await flushEvents();
        return;
      } catch (error) {
        await this.assertTaskLease(task);
        if (error?.code === 'REGISTRATION_WORKER_LEASE_LOST') throw error;
        lastError = error;
        const retryable = error?.retryableProxy !== false && shouldQuarantineProxy(error);
        if (retryable) {
          await this.proxyPools.main.markBad(proxy.id, {
            poolId: proxy.poolId || poolId,
            reason: error.code || error.message,
          }).catch(() => {});
        }
        update({
          type: 'credential_repair.attempt_failed',
          status: 'running',
          step: 'credential_repair_attempt_failed',
          proxyAttempt: attempt,
          willRetry: retryable && attempt < this.config.browser.maxProxyAttempts,
          error: { code: error?.code || 'CREDENTIAL_REPAIR_FAILED', message: String(error?.message || error) },
        });
        if (!retryable) throw error;
      }
    }
    throw lastError || Object.assign(new Error('credential repair proxy pool is unavailable'), {
      code: 'CREDENTIAL_REPAIR_PROXY_UNAVAILABLE',
      retryableProxy: false,
    });
  }

  async run(taskId) {
    const id = String(taskId || '').trim();
    if (!id || this.running.has(id)) return null;
    const claimed = await this.registrationStore.claimJob({
      jobId: id,
      workerId: this.workerId,
      leaseMs: this.leaseMs,
    });
    if (!claimed) return null;
    return this.runClaimed(claimed);
  }

  async runClaimed(claimedTask) {
    const taskId = String(claimedTask?.id || '').trim();
    const claimedBy = String(claimedTask?.claimedBy || '').trim();
    if (!taskId || !claimedBy || claimedTask?.status !== 'running') {
      const error = new Error('runClaimed requires a running database job with claimedBy');
      error.code = 'REGISTRATION_CLAIM_INVALID';
      throw error;
    }
    if (this.running.has(taskId)) return null;
    const task = await this.registrationStore.loadJob({
      jobId: taskId,
      includeSecret: true,
    });
    if (!task || task.status !== 'running' || task.claimedBy !== claimedBy
      || (claimedTask.attemptCount !== undefined && task.attemptCount !== claimedTask.attemptCount)) {
      const error = new Error('registration job claim is stale or owned by another worker');
      error.code = 'REGISTRATION_CLAIM_STALE';
      throw error;
    }
    const guard = { jobId: taskId, workerId: claimedBy, attemptCount: Number(claimedTask.attemptCount ?? task.attemptCount ?? 1) };
    const leaseController = new AbortController();
    task.leaseGuard = guard;
    task.leaseSignal = leaseController.signal;
    let leaseError = null;
    const loseLease = (cause) => {
      if (!leaseError) {
        leaseError = Object.assign(new Error('registration worker lease lost', { cause }), {
          code: 'REGISTRATION_WORKER_LEASE_LOST', retryableProxy: false,
        });
        leaseController.abort(leaseError);
      }
      return leaseError;
    };
    task.onLeaseLost = loseLease;
    await this.assertTaskLease(task);
    this.running.add(taskId);
    let leaseRenewing = false;
    const renewLease = async () => {
      if (leaseRenewing || leaseError || guard.allowTerminal) return;
      leaseRenewing = true;
      try {
        const renewed = await this.registrationStore.renewLease({
          jobId: taskId,
          workerId: claimedBy,
          guard,
          leaseMs: this.leaseMs,
        });
        if (!renewed && !leaseStopped && !guard.allowTerminal) {
          const error = new Error('registration worker no longer owns the database job lease');
          error.code = 'REGISTRATION_WORKER_LEASE_LOST';
          error.retryableProxy = false;
          loseLease(error);
        }
      } catch (error) {
        if (!leaseStopped && !guard.allowTerminal) loseLease(error);
      } finally {
        leaseRenewing = false;
      }
    };
    const leaseTimer = setInterval(() => {
      renewLease().catch(() => {});
    }, Math.max(10000, Math.trunc(this.leaseMs / 3)));
    leaseTimer.unref?.();
    let leaseStopped = false;
    const stopLeaseHeartbeat = () => {
      if (leaseStopped) return;
      leaseStopped = true;
      clearInterval(leaseTimer);
    };
    const evidence = new EvidenceStore({
      dataDir: this.config.dataDir,
      taskId,
      store: this.runtimeStateStore,
    });
    let eventQueue = Promise.resolve();
    let evidenceQueue = Promise.resolve();
    let eventWriteError = null;
    let evidenceWriteError = null;
    const recordEvidence = (event) => {
      evidenceQueue = evidenceQueue.then(async () => {
        if (evidenceWriteError) return;
        try {
          await evidence.record(event);
        } catch (error) {
          evidenceWriteError = error;
        }
      });
      return evidenceQueue;
    };
    const update = (event) => {
      recordEvidence({ type: event.type || 'registration.event', payload: event });
      eventQueue = eventQueue.then(async () => {
        if (eventWriteError) return;
        try {
          if (leaseError) throw leaseError;
          await this.registrationStore.appendEvent({ jobId: taskId, event, guard });
          if (event.status === 'failed' || event.status === 'cancelled' || event.status === 'blocked'
            || event.step === 'completed' || event.type === 'registration.completed') {
            guard.allowTerminal = true;
            stopLeaseHeartbeat();
          }
        } catch (error) {
          eventWriteError = error;
          if (error?.code === 'REGISTRATION_WORKER_LEASE_LOST') loseLease(error);
        }
      });
      return eventQueue;
    };
    const flushEvents = async () => {
      await Promise.all([eventQueue, evidenceQueue]);
      if (eventWriteError) {
        eventWriteError.retryableProxy = false;
        throw eventWriteError;
      }
      if (evidenceWriteError) {
        evidenceWriteError.retryableProxy = false;
        throw evidenceWriteError;
      }
      if (leaseError) throw leaseError;
    };

    let session;
    let lastError = null;
    let browserEngine = null;
    try {
      const taskConfig = this.browserConfigForTask(task);
      const entryBranch = assertRegistrationBranch(this.config, this.entryBranchForTask(task));
      const registrationExtras = this.changeEmailSettings?.getSecretConfig?.() || {};
      browserEngine = taskConfig.browser.engine;
      const timeoutMs = taskConfig.browser.operationTimeoutMs;
      if (task.mode === 'credential_repair') {
        await this.runCredentialRepair(task, { update, flushEvents, signal: leaseController.signal });
        stopLeaseHeartbeat();
        return;
      }
      const attemptedProxyIds = new Set();
      const maxProxyAttempts = this.config.browser.maxProxyAttempts;
      // FreePP may already have submitted the email and requested an OTP.
      // Replaying that whole flow many times causes repeated OTP waits and keeps
      // one alias alive for tens of minutes. Three complete attempts are enough
      // before the terminal cleanup path takes over.
      const freeppMaxProxyAttempts = maxProxyAttempts;
      const mainProxyPoolId = task.proxyPoolId || undefined;
      const mainProxyPool = mainProxyPoolId
        ? this.proxyPools.main.listPools().find((pool) => pool.id === mainProxyPoolId)
        : null;
      const expectedProxyCountry = expectedCountryFromPool(mainProxyPool);
      const executionType = executionTypeForImplementation(entryBranch);
      if (!executionType) {
        const error = new Error(`registration implementation is not registered: ${entryBranch}`);
        error.code = 'REGISTRATION_IMPLEMENTATION_UNREGISTERED';
        error.retryableProxy = false;
        throw error;
      }
      const isProtocolBranch = isProtocolEntryBranch(entryBranch);
      update({
        type: 'registration.started',
        status: 'running',
        step: 'starting',
        executionType: executionType.key,
        browserEngine: usesFingerprintBrowser(entryBranch) ? taskConfig.browser.engine : null,
        browserEngineSource: usesFingerprintBrowser(entryBranch)
          ? (task.browserEngine ? 'task' : 'service')
          : 'not_applicable',
        entryBranch,
        entryBranchSource: task.entryBranch ? 'task' : 'service',
      });
      let registrationProxy = null;
      let registrationProxyAttempt = null;
      let otpIssuedAt = Date.now();

      if (isProtocolBranch) {
        for (let attempt = 1; attempt <= freeppMaxProxyAttempts; attempt += 1) {
          let proxy = null;
          let proxyGeo = null;
          try {
            await this.assertTaskLease(task);
            proxy = await this.proxyPools.main.pickNext({ poolId: mainProxyPoolId, excludeIds: [...attemptedProxyIds] });
            if (!proxy && mainProxyPoolId) {
              if (lastError) {
                lastError.retryableProxy = false;
                update({
                  type: 'proxy.exhausted',
                  step: 'proxy_exhausted',
                  proxyAttempt: attempt,
                  proxyPoolId: mainProxyPoolId,
                  preservedError: {
                    code: lastError.code || lastError.name || 'REGISTRATION_FAILED',
                    message: String(lastError.message || lastError),
                  },
                });
                throw lastError;
              }
              const error = new Error('selected proxy pool has no available proxy outside cooldown');
              error.code = 'PROXY_POOL_NO_AVAILABLE_PROXY';
              error.retryableProxy = false;
              throw error;
            }
            if (proxy) attemptedProxyIds.add(proxy.id);
            update({
              type: 'proxy.selected',
              step: 'proxy_selected',
              proxyAttempt: attempt,
              proxy: proxy ? { id: proxy.id, country: proxy.country, host: proxy.host, port: proxy.port } : null,
            });
            if (proxy) {
              const preflight = await this.proxyQualityChecker(proxy, {
                expectedCountry: expectedProxyCountry,
                timeoutMs: Math.min(10000, Math.max(2000, Number(timeoutMs) || 8000)),
                maxLatencyMs: Math.min(15000, Math.max(5000, Number(timeoutMs) || 15000)),
              });
              proxyGeo = preflight.geo || null;
              await this.assertTaskLease(task);
              await this.proxyPools.main.markChecked?.(proxy.id, {
                poolId: proxy.poolId || mainProxyPoolId,
                latencyMs: preflight.geo?.latencyMs ?? null,
                country: preflight.geo?.countryCode || null,
              });
              update({
                type: 'proxy.quality_verified',
                step: 'proxy_quality_verified',
                proxyAttempt: attempt,
                expectedCountry: expectedProxyCountry || null,
                geo: {
                  ip: preflight.geo?.ip || null,
                  countryCode: preflight.geo?.countryCode || null,
                  timezone: preflight.geo?.timezone || null,
                  city: preflight.geo?.city || null,
                  asn: preflight.geo?.asn || null,
                  asName: preflight.geo?.asName || null,
                  isp: preflight.geo?.isp || null,
                  proxy: preflight.geo?.proxy ?? null,
                  hosting: preflight.geo?.hosting ?? null,
                  mobile: preflight.geo?.mobile ?? null,
                  latencyMs: preflight.geo?.latencyMs || null,
                },
              });
            }
            const mailbox = await this.mailboxProviderForTask(task);
              await this.assertTaskLease(task);
              const freeppResult = await this.freeppRegistrationRunner({
                signal: leaseController.signal,
                config: this.config,
                task,
                proxy,
                mailbox,
                entryBranch,
                phoneBindSettings: this.phoneBindSettings,
              changeEmailSettings: this.changeEmailSettings,
              update,
              startedAt: otpIssuedAt,
            });
            await flushEvents();
            await this.assertTaskLease(task);
            const registeredEmail = freeppResult.email || task.email;
            const validateOauthSession = registrationExtras.validateOauthSession === true;
            const phoneBindProbeEnabled = registrationExtras.phoneBindProbeEnabled === true;
            const autoCheckEligibility = registrationExtras.autoCheckEligibility === true;
            const phoneBindProbeResult = freeppResult.phoneBindProbe && Object.keys(freeppResult.phoneBindProbe).length
              ? freeppResult.phoneBindProbe
              : null;
            if (phoneBindProbeEnabled && phoneBindProbeResult) {
              update({
                type: 'registration.phone_bind_probe',
                status: 'running',
                step: 'phone_bind_probe',
                result: phoneBindProbeResult,
              });
            }
            const now = new Date().toISOString();
            const oauthSession = freeppOauthSession(freeppResult.oauthSession, { capturedAt: now, taskId });
            const oauthQualified = successfulFreeppOauthQualification(phoneBindProbeResult);
            const hasUsableToken = Boolean(freeppResult.accessToken || freeppResult.sessionToken || freeppResult.refreshToken);
            const registrationEnvironment = {
              taskId,
              proxyAttempt: attempt,
              proxyPoolId: mainProxyPoolId || null,
              proxy: proxy ? {
                id: proxy.id,
                country: proxy.country,
                host: proxy.host,
                port: proxy.port,
                poolId: proxy.poolId || mainProxyPoolId || null,
              } : null,
              exit: proxyGeo ? {
                ip: proxyGeo.ip || null,
                countryCode: proxyGeo.countryCode || null,
                timezone: proxyGeo.timezone || null,
                city: proxyGeo.city || null,
                asn: proxyGeo.asn || null,
                asName: proxyGeo.asName || null,
                isp: proxyGeo.isp || null,
                proxy: proxyGeo.proxy ?? null,
                hosting: proxyGeo.hosting ?? null,
                mobile: proxyGeo.mobile ?? null,
              } : null,
                branch: entryBranch,
            };
            const eligibilityCheck = freeppResult.eligibilityCheck;
            const eligibilityChecked = eligibilityCheck?.status === 'checked'
              && Number(eligibilityCheck?.http_status || 0) === 200;
            const firstPartyTrialEligible = Boolean(eligibilityCheck?.first_party_trial_eligible);
            const accountsTrialEligibility = eligibilityChecked
              ? analyzeTrialEligibility(eligibilityCheck.accounts_check)
              : null;
            const freeppEligibility = eligibilityChecked || firstPartyTrialEligible ? {
              checkedAt: eligibilityCheck.checked_at
                ? new Date(Number(eligibilityCheck.checked_at)).toISOString()
                : now,
              proxy: proxy ? { id: proxy.id, country: proxy.country, host: proxy.host, port: proxy.port } : null,
              sessionStatus: 200,
              accountsCheckSource: 'freepp_live_session',
              accountsCheckStatus: 200,
              trialEligibility: firstPartyTrialEligible
                ? { status: 'eligible', label: '试用资格可用', reason: 'first-party eligibility endpoint reported trial eligibility', promoId: null, hits: [] }
                : accountsTrialEligibility,
              accountsTrialEligibility,
              firstPartyTrialEligible,
            } : null;
            const freeppEligibilityError = autoCheckEligibility && !freeppEligibility
              ? {
                code: freeppResult.eligibilityError?.code || 'FREEPP_ELIGIBILITY_CHECK_FAILED',
                status: Number(eligibilityCheck?.http_status || 0) || null,
                message: freeppResult.eligibilityError?.message || '同一注册会话内的资格检测没有完成。',
              }
              : null;
            const sessionCookies = freeppSessionCookies(freeppResult.sessionToken, freeppResult.sessionContext);
            const accountOauthSession = oauthSession;
            const freeppAccount = {
              email: registeredEmail,
              status: 'registration_in_progress',
              registrationCreated: true,
              lastTaskId: taskId,
              password: freeppResult.password || task.registrationPassword,
              loginEmail: freeppResult.loginEmail || registeredEmail,
              emailChange: freeppResult.emailChange || null,
              emailChangeError: freeppResult.emailChangeError || null,
              passwordStatus: freeppResult.passwordStatus,
              passwordStatusSource: 'registration_flow',
              passwordStatusUpdatedAt: now,
              passwordSetupError: freeppResult.passwordError || null,
              passwordSessionRefreshError: freeppResult.passwordSessionRefreshError || null,
              sessionAvailable: Boolean(freeppResult.sessionToken),
              ...(sessionCookies.length ? {
                session: {
                  cookies: sessionCookies,
                  capturedAt: now,
                  sourceTaskId: taskId,
                  source: 'freepp',
                },
              } : {}),
              ...(freeppResult.sessionContext ? { sessionContext: freeppResult.sessionContext } : {}),
              phoneBindOauthQualified: Boolean(phoneBindProbeEnabled && oauthQualified),
              phoneBindOauthQualifiedAt: phoneBindProbeEnabled && oauthQualified ? now : null,
              phoneBindOauthQualification: {
                qualified: Boolean(phoneBindProbeEnabled && oauthQualified),
                skipped: !phoneBindProbeEnabled,
                source: phoneBindProbeEnabled ? 'registration_oauth_probe' : 'registration_config_disabled',
                accountSelectReached: Boolean(phoneBindProbeResult?.accountSelectSessionAvailable),
                addPhoneReached: Boolean(phoneBindProbeResult?.addPhoneUrlAvailable),
                sessionSelectStatus: Number(phoneBindProbeResult?.sessionSelectStatus || 0) || null,
              },
              oauthSessionAvailable: Boolean(accountOauthSession),
              ...(accountOauthSession ? { oauthSession: accountOauthSession } : {}),
              registrationEnvironment,
              tokens: {
                accessToken: freeppResult.accessToken || '',
                sessionToken: freeppResult.sessionToken || '',
                refreshToken: freeppResult.refreshToken || '',
                raw: freeppResult.tokenJson || {},
                refreshedAt: now,
              },
              accessTokenLastRefreshedAt: now,
              eligibilityStatus: trialEligibilityStatus(freeppEligibility?.trialEligibility) || 'unknown',
              trialEligibility: freeppEligibility?.trialEligibility || null,
              eligibilityLastResult: freeppEligibility,
              eligibilityLastCheckedAt: freeppEligibility?.checkedAt || null,
              eligibilityError: freeppEligibilityError,
              finalAtValidation: freeppResult.finalAtValidation || null,
              completionError: freeppResult.completionError || null,
              ...(freeppResult.totpSecret ? {
                hasTotp: true,
                totpSecret: freeppResult.totpSecret,
                totpActiveFactorId: freeppResult.totpActiveFactorId || null,
                totpEnrollmentSessionId: freeppResult.totpEnrollmentSessionId || null,
                totpSetupAt: now,
                totpVerified: freeppResult.totpVerified,
                totpActivated: freeppResult.totpActivated,
                totpSetupError: freeppResult.totpError || null,
              } : registrationExtras.setupTotp2fa === true ? {
                totpSetupError: {
                  code: freeppResult.totpError?.code || 'TOTP_2FA_ACCESS_TOKEN_UNAVAILABLE',
                  status: null,
                  message: freeppResult.totpError?.message
                    || (freeppResult.accessToken ? 'freepp 2FA setup did not return a TOTP secret' : '2FA setup skipped because freepp did not return an access token'),
                },
              } : {}),
            };
            await this.saveCommittedRegistrationProgress({ jobId: taskId, patch: freeppAccount, guard });
            assertNoCompletionError(freeppResult);
            if (validateOauthSession && !hasUsableOauthSession(oauthSession)) {
              const error = new Error('FREEPP_OAUTH_COOKIE_MISSING: FreePP OAuth did not return oai-client-auth-session');
              error.code = 'FREEPP_OAUTH_COOKIE_MISSING';
              error.retryableProxy = false;
              update({
                type: 'registration.freepp_oauth_cookie_missing',
                status: 'failed',
                step: 'freepp_oauth_cookie_missing',
                error: {
                  code: error.code,
                  message: 'FreePP OAuth 未保存 oai-client-auth-session，账号无效，终止后续流程。',
                },
              });
              throw error;
            }
            if (phoneBindProbeEnabled && !oauthQualified) {
              const probe = phoneBindProbeResult || {};
              const error = new Error(
                `FREEPP_OAUTH_QUALIFICATION_FAILED: ${String(probe.error || 'OAuth qualification did not reach add-phone')}`,
              );
              // The registration OAuth probe is a qualification gate only. Failed accounts must not enter
              // eligibility, refining, payment, or phone binding.
              error.code = 'FREEPP_OAUTH_COOKIE_MISSING';
              error.retryableProxy = false;
              update({
                type: 'registration.freepp_phone_bind_oauth_incomplete',
                status: 'failed',
                step: 'freepp_phone_bind_oauth_incomplete',
                error: {
                  code: error.code,
                  message: '注册阶段 OAuth 资格校验未到达 add-phone，账号无效，终止后续流程并删除。',
                },
                result: {
                  attempts: Number(probe.attempts || 1),
                  saveableForLater: Boolean(probe.saveableForLater),
                  reusableForLater: Boolean(probe.reusableForLater),
                  accountSelectSessionAvailable: Boolean(probe.accountSelectSessionAvailable),
                  sub2SessionIdAvailable: Boolean(probe.sub2SessionIdAvailable),
                  authCookieMaterialAvailable: Boolean(probe.authCookieMaterialAvailable),
                },
              });
              throw error;
            }
            if (!hasUsableToken) {
              const error = new Error('FREEPP_TOKEN_UNAVAILABLE: freepp created the account but did not return an access token or session token');
              error.code = 'FREEPP_TOKEN_UNAVAILABLE';
              error.retryableProxy = false;
              update({
                type: 'registration.freepp_token_unavailable',
                status: 'failed',
                step: 'freepp_token_unavailable',
                error: {
                  code: error.code,
                  message: 'FreePP 已创建账号，但 next-auth callback 没有拿到 AT/session-token，不能算注册完成。',
                },
              });
              throw error;
            }
            if (freeppResult.passwordStatus !== 'has_password') {
              update({
                type: 'registration.freepp_password_unavailable',
                status: 'running',
                step: 'freepp_password_unavailable',
                error: {
                  code: freeppResult.passwordError?.code || 'FREEPP_PASSWORD_UNAVAILABLE',
                  message: freeppResult.passwordError?.message
                    || 'FreePP 没有完成密码创建；账号、AT 和登录状态已保存，后续按无密码账号处理。',
                },
              });
            }
            if (registrationExtras.setupTotp2fa === true && (!freeppResult.totpSecret || freeppResult.totpVerified === false)) {
              update({
                type: 'registration.freepp_twofa_unavailable',
                status: 'running',
                step: 'freepp_twofa_unavailable',
                error: {
                  code: freeppResult.totpError?.code || 'FREEPP_TOTP_UNAVAILABLE',
                  message: freeppResult.totpError?.message || 'FreePP 没有完成 2FA 设置；账号和 AT 已保存，但复制账号会缺少 2FA。',
                },
              });
            }
            let effectiveTrialEligibility = freeppEligibility?.trialEligibility || null;
            assertConfiguredRegistrationCompletion({
              registrationExtras,
              freeppResult,
              oauthSession: accountOauthSession,
              oauthQualified,
              trialEligibility: effectiveTrialEligibility,
            });
            update({
              type: 'registration.post_steps_completed',
              status: 'running',
              step: 'post_steps_completed',
              result: {
                passwordRequired: registrationExtras.setupPassword === true,
                totpRequired: registrationExtras.setupTotp2fa === true,
                loginStateRequired: registrationExtras.validateOauthSession === true,
                phoneBindEntryRequired: registrationExtras.phoneBindProbeEnabled === true,
                eligibilityRequired: registrationExtras.autoCheckEligibility === true,
                trialEligibility: effectiveTrialEligibility,
              },
            });
            const completionResult = {
                branch: entryBranch,
              email: registeredEmail,
              loginEmail: freeppResult.loginEmail || registeredEmail,
              emailChange: freeppResult.emailChange || null,
              emailChangeError: freeppResult.emailChangeError || null,
              accessTokenAvailable: Boolean(freeppResult.accessToken),
              sessionTokenAvailable: Boolean(freeppResult.sessionToken),
              oauthSessionAvailable: Boolean(accountOauthSession),
              hasPassword: freeppResult.passwordStatus === 'has_password',
              passwordStatus: freeppResult.passwordStatus || 'no_password',
              passwordError: freeppResult.passwordError || null,
              hasTotp: Boolean(freeppResult.totpSecret),
              totpError: freeppResult.totpError || null,
              trialEligibility: effectiveTrialEligibility,
              finalAtValidation: freeppResult.finalAtValidation || null,
            };
            await flushEvents();
            stopLeaseHeartbeat();
            await this.finishRegistration({
              guard,
              jobId: taskId,
              account: {
                ...freeppAccount,
                trialEligibility: effectiveTrialEligibility,
                eligibilityStatus: trialEligibilityStatus(effectiveTrialEligibility) || 'unknown',
              },
              event: { result: completionResult },
            });
            guard.allowTerminal = true;
            await this.recordTerminalMailComDomainResult(task, { ok: true, trialEligibility: effectiveTrialEligibility });
            const release = await this.releaseTerminalMailComAlias(task, update);
            await this.transitionTerminalMailComWorkflow(task, {
              release,
              trialEligibility: effectiveTrialEligibility,
            });
            await recordEvidence({
              type: 'registration.completed',
              payload: { status: 'succeeded', step: 'completed', result: completionResult },
            });
            return;
          } catch (error) {
            if (leaseError || error?.code === 'REGISTRATION_WORKER_LEASE_LOST') throw loseLease(error);
            await this.assertTaskLease(task);
            lastError = error;
            const persistedJob = await this.registrationStore.loadJob({ jobId: taskId });
            if (persistedJob?.status === 'completed') {
              await recordEvidence({
                type: 'registration.completion_response_failed',
                payload: {
                  taskId,
                  error: { code: error?.code || 'COMPLETION_RESPONSE_FAILED', message: String(error?.message || error) },
                },
              });
              return;
            }
            const retryableProxyError = error?.retryableProxy !== false;
            const safeToRetry = retryableProxyError && attempt < freeppMaxProxyAttempts;
            if (proxy && retryableProxyError && shouldQuarantineProxy(error)) {
              const cooled = await this.proxyPools.main.markBad(proxy.id, { poolId: proxy.poolId || mainProxyPoolId, reason: error?.message || error });
              update({
                type: 'proxy.rejected',
                step: 'proxy_rejected',
                proxyAttempt: attempt,
                proxy: { id: proxy.id, country: proxy.country, host: proxy.host, port: proxy.port },
                reason: String(error?.message || error).split('\n')[0],
                cooldownUntil: cooled?.cooldownUntil || null,
                willRetry: safeToRetry,
              });
            } else if (proxy && !retryableProxyError) {
              update({
                type: 'proxy.not_rejected',
                step: 'proxy_not_rejected',
                proxyAttempt: attempt,
                proxy: { id: proxy.id, country: proxy.country, host: proxy.host, port: proxy.port },
                reason: String(error?.message || error).split('\n')[0],
                willRetry: false,
              });
            }
            if (!safeToRetry) throw error;
            update({ type: 'registration.retrying_proxy', status: 'running', step: 'retrying_proxy', nextProxyAttempt: attempt + 1 });
          }
        }
        if (lastError) throw lastError;
      }

      let passwordStatus = 'no_password';
      const browserProxyAttempts = maxProxyAttempts;
      for (let attempt = 1; attempt <= browserProxyAttempts; attempt += 1) {
        let proxy = null;
        let proxyGeo = null;
        let emailSubmitted = false;
        try {
          proxy = await this.proxyPools.main.pickNext({ poolId: mainProxyPoolId, excludeIds: [...attemptedProxyIds] });
          if (!proxy && mainProxyPoolId) {
            const error = new Error('selected proxy pool has no available proxy outside cooldown');
            error.code = 'PROXY_POOL_NO_AVAILABLE_PROXY';
            error.retryableProxy = false;
            throw error;
          }
          if (proxy) attemptedProxyIds.add(proxy.id);
          update({
            type: 'proxy.selected',
            step: 'proxy_selected',
            proxyAttempt: attempt,
            proxy: proxy ? { id: proxy.id, country: proxy.country, host: proxy.host, port: proxy.port } : null,
          });
          if (proxy) {
            const preflight = await this.proxyQualityChecker(proxy, {
              expectedCountry: expectedProxyCountry,
              timeoutMs: Math.min(10000, Math.max(2000, Number(timeoutMs) || 8000)),
              maxLatencyMs: Math.min(15000, Math.max(5000, Number(timeoutMs) || 15000)),
            });
            proxyGeo = preflight.geo || null;
            await this.assertTaskLease(task);
            await this.proxyPools.main.markChecked?.(proxy.id, {
              poolId: proxy.poolId || mainProxyPoolId,
              latencyMs: preflight.geo?.latencyMs ?? null,
              country: preflight.geo?.countryCode || null,
            });
            update({
              type: 'proxy.quality_verified',
              step: 'proxy_quality_verified',
              proxyAttempt: attempt,
              expectedCountry: expectedProxyCountry || null,
              geo: {
                countryCode: preflight.geo?.countryCode || null,
                timezone: preflight.geo?.timezone || null,
                city: preflight.geo?.city || null,
                latencyMs: preflight.geo?.latencyMs || null,
              },
            });
          }
          update({ type: 'browser.launching', step: 'browser_launching', proxyAttempt: attempt });

          session = await createFingerprintBrowserSession({
            config: taskConfig,
            proxy: proxy ? { ...proxy, ip: proxyGeo?.ip || null, timezone: proxyGeo?.timezone || null } : proxy,
            collectorFactory: async ({ page, context }) => {
              const collector = new FullNetworkCollector({
                page,
                context,
                store: evidence,
                taskId,
                blockImages: this.config.collector.blockImages,
                captureBodies: this.config.collector.captureBodies,
                captureRaw: this.config.collector.captureRaw,
                maxBodyBytes: this.config.collector.maxBodyBytes,
                captureFilePath: evidence.artifactPath('network-raw.jsonl'),
                captureContext: {
                  taskId,
                  email: task.email || null,
                  entryBranch,
                  browserEngine: taskConfig.browser.engine,
                  fingerprintId: task.fingerprintId || task.fingerprint || task.browserFingerprintId || null,
                  proxyPoolId: mainProxyPoolId || null,
                  proxyId: proxy?.id || null,
                  proxyHost: proxy?.host || null,
                  proxyPort: proxy?.port || null,
                  proxyCountry: proxy?.country || expectedProxyCountry || null,
                },
                maxEvents: this.config.collector.maxEvents,
              });
              return collector.start();
            },
          });

          const browserFlowTimeoutMs = Math.max(timeoutMs, 90000);
          for (const step of [
            () => openChatgptHome({ page: session.page, timeoutMs: browserFlowTimeoutMs }),
            async () => {
              const browserEntryHandlers = {
                flowpilot: openFlowPilotEmailEntry,
                context_protocol: openContextProtocolEmailEntry,
              };
              const openEmailEntry = browserEntryHandlers[entryBranch];
              if (!openEmailEntry) {
                const error = new Error(`browser-assisted registration handler is missing: ${entryBranch}`);
                error.code = 'REGISTRATION_IMPLEMENTATION_HANDLER_MISSING';
                error.retryableProxy = false;
                throw error;
              }
              update({
                type: 'registration.entry_branch_selected',
                status: 'running',
                step: 'entry_branch_selected',
                entryBranch,
              });
              const result = await openEmailEntry({
                page: session.page,
                context: session.context,
                email: task.email,
                timeoutMs: browserFlowTimeoutMs,
                onEvent: (event) => update({
                  type: `registration.${event.step || event.type || 'email_event'}`,
                  status: 'running',
                  entryBranch,
                  ...(event || {}),
                }),
              });
              await savePageSnapshot({
                page: session.page,
                evidence,
                update,
                label: 'after-email-branch',
                step: 'after_email_branch_snapshot',
                extra: {
                  entryBranch,
                  detectedBranch: result?.branch?.kind || result?.emailSubmit?.nextStepKind || null,
                },
              });
              if (Number.isFinite(Number(result?.otpIssuedAt))) {
                otpIssuedAt = Number(result.otpIssuedAt);
              }
              emailSubmitted = true;
              if (result?.branch?.kind === 'login_password_required' || result?.emailSubmit?.nextStepKind === 'login_password') {
                update({
                  type: 'registration.login_password_branch_reached',
                  status: 'failed',
                  step: 'login_password_required',
                  result: {
                    branch: result.branch || null,
                    nextStepKind: result.emailSubmit?.nextStepKind || null,
                  },
                });
                throw new RegistrationPasswordBranchError(
                  'email reached existing-account password login branch before OTP; no email-otp/send request was made',
                  { branch: result.branch || null, nextStepKind: result.emailSubmit?.nextStepKind || null },
                );
              }
              if (result?.branch?.kind === 'create_password_required' || result?.emailSubmit?.nextStepKind === 'create_password') {
                update({
                  type: 'registration.create_password_branch_reached',
                  status: 'running',
                  step: 'create_password_required',
                  result: {
                    branch: result.branch || null,
                    nextStepKind: result.emailSubmit?.nextStepKind || null,
                  },
                });
                otpIssuedAt = Date.now();
                const passwordResult = await submitCreatePasswordBeforeOtp({
                  page: session.page,
                  password: task.registrationPassword,
                  timeoutMs,
                });
                update({
                  type: `registration.${passwordResult.step}`,
                  status: 'running',
                  step: passwordResult.step,
                  result: passwordResult,
                });
                passwordStatus = 'has_password';
              }
              return result;
            },
          ]) {
            const result = await step();
            update({ type: `registration.${result.step}`, step: result.step, result });
          }
          lastError = null;
          registrationProxy = proxy;
          registrationProxyAttempt = attempt;
          break;
        } catch (error) {
          lastError = error;
          if (session?.page) {
            await savePageSnapshot({
              page: session.page,
              evidence,
              update,
              label: `attempt-${attempt}-failure`,
              step: 'page_snapshot_saved',
              error,
              extra: { proxyAttempt: attempt },
            });
          }
          try { await session?.close?.(); } catch {}
          session = null;
          const retryableProxyError = error?.retryableProxy !== false;
          const safeToRetry = !emailSubmitted && retryableProxyError && attempt < browserProxyAttempts;
          if (proxy && !emailSubmitted && retryableProxyError && shouldQuarantineProxy(error)) {
            const cooled = await this.proxyPools.main.markBad(proxy.id, { poolId: proxy.poolId || mainProxyPoolId, reason: error?.message || error });
            update({
              type: 'proxy.rejected',
              step: 'proxy_rejected',
              proxyAttempt: attempt,
              proxy: { id: proxy.id, country: proxy.country, host: proxy.host, port: proxy.port },
              reason: String(error?.message || error).split('\n')[0],
              cooldownUntil: cooled?.cooldownUntil || null,
              willRetry: safeToRetry,
            });
          } else if (proxy && !emailSubmitted && (!retryableProxyError || !shouldQuarantineProxy(error))) {
            update({
              type: 'proxy.not_rejected',
              step: 'proxy_not_rejected',
              proxyAttempt: attempt,
              proxy: { id: proxy.id, country: proxy.country, host: proxy.host, port: proxy.port },
              reason: String(error?.message || error).split('\n')[0],
              willRetry: false,
            });
          }
          if (!safeToRetry) throw error;
          update({ type: 'registration.retrying_proxy', status: 'running', step: 'retrying_proxy', nextProxyAttempt: attempt + 1 });
        }
      }
      if (lastError) throw lastError;

      await this.accountAssetStore.saveProgress({
        jobId: taskId,
        guard,
        patch: { status: 'registration_in_progress', lastTaskId: taskId },
      });
      update({ type: 'registration.paused_for_otp', status: 'waiting_for_otp', step: 'otp_required' });
      const mailbox = await this.mailboxProviderForTask(task);
      if (!mailbox.provider) {
        const error = new Error(`no mailbox provider is configured for ${task.mailboxSource}`);
        error.code = 'MAILBOX_PROVIDER_REQUIRED';
        error.retryableProxy = false;
        throw error;
      }
      let mailboxResult;
      try {
        const resendOtp = async () => {
          if (!session?.page || typeof session.page.evaluate !== 'function') {
            return { ok: false, mode: 'otp_resend_context_missing' };
          }
          const deadline = Date.now() + 25000;
          let last = null;
          while (Date.now() < deadline) {
            last = await session.page.evaluate(() => {
              const visible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.visibility !== 'hidden'
                  && style.display !== 'none'
                  && rect.width > 0
                  && rect.height > 0
                  && !element.disabled
                  && element.getAttribute('aria-disabled') !== 'true';
              };
              const nodes = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')]
                .filter(visible);
              const preferred = nodes.find((element) => {
                const name = String(element.getAttribute('name') || '').toLowerCase();
                const value = String(element.getAttribute('value') || '').toLowerCase();
                return name === 'intent' && value === 'resend';
              }) || nodes.find((element) => {
                const attrs = [
                  element.id, element.name, element.value, element.getAttribute('data-testid'),
                  element.getAttribute('data-action'), element.getAttribute('aria-label'),
                  element.getAttribute('title'), element.className,
                ].filter(Boolean).join(' ').toLowerCase();
                return /resend|send.?again|retry|email.?code/.test(attrs);
              }) || nodes.find((element) => /resend|send again|重新发送|重发/i.test(String(element.innerText || element.textContent || '')));
              if (!preferred) return { ok: false, reason: 'resend_button_not_found' };
              preferred.scrollIntoView({ block: 'center' });
              preferred.click();
              return {
                ok: true,
                mode: 'dom_technical_resend',
                name: preferred.getAttribute('name') || '',
                value: preferred.getAttribute('value') || '',
              };
            }).catch(() => null);
            if (last?.ok) return last;
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
          return last || { ok: false, mode: 'otp_resend_not_found' };
        };
        mailboxResult = await waitForVerificationCodeWithResends({
          provider: mailbox.provider,
          email: task.email,
          after: Number.isFinite(otpIssuedAt) ? otpIssuedAt : task.createdAt,
          timeoutMs: this.config.mailbox.pollTimeoutMs,
          intervalMs: this.config.mailbox.pollIntervalMs,
          phase1TimeoutMs: this.config.mailbox.otpPhase1Ms,
          phase2TimeoutMs: this.config.mailbox.otpPhase2Ms,
          maxAttempts: 3,
          resend: resendOtp,
          onEvent: (event) => update({
            ...event,
            mailboxSource: mailbox.source,
            status: 'waiting_for_otp',
            step: event.type === 'mailbox.code_found' ? 'otp_code_available' : 'mailbox_polling',
          }),
        });
      } catch (error) {
        const providerFailed = error?.code && error.code !== 'MAILBOX_CODE_TIMEOUT';
        update({
          type: 'mailbox.poll_timeout',
          status: 'running',
          step: 'mailbox_polling_failed',
          error: {
            code: error?.code || 'MAILBOX_POLL_FAILED',
            message: String(error?.message || error),
          },
          providerFailed,
        });
        throw error;
      }

      update({
        type: 'registration.otp_code_available',
        status: 'waiting_for_otp',
        step: 'otp_code_available',
        otpCode: mailboxResult.code,
        mailbox: {
          mailId: mailboxResult.mail?.id || null,
          receivedAt: mailboxResult.mail?.receivedAt || null,
          subject: mailboxResult.mail?.subject || '',
          sender: mailboxResult.mail?.sender || '',
          attempts: mailboxResult.attempts,
          elapsedMs: mailboxResult.elapsedMs,
        },
      });

      const otpResult = await submitOtp({ page: session.page, otp: mailboxResult.code, timeoutMs });
      update({ type: `registration.${otpResult.step}`, status: 'running', step: otpResult.step, result: otpResult });

      let finalResult = await maybeFinalizeSession({
        page: session.page,
        timeoutMs: Math.min(5000, Math.max(1000, Number(timeoutMs) || 30000)),
      });
      if (finalResult) {
        update({
          type: 'registration.session_finalized_after_otp',
          status: 'running',
          step: 'session_finalized_after_otp',
          result: finalResult,
        });
      } else {
        const profileResult = await submitProfile({ page: session.page, timeoutMs });
        const { continueUrl: _continueUrl, ...profileEventResult } = profileResult;
        update({ type: `registration.${profileResult.step}`, status: 'running', step: profileResult.step, result: profileEventResult });
        await savePageSnapshot({
          page: session.page,
          evidence,
          update,
          label: 'after-profile-submit',
          step: 'after_profile_submit_snapshot',
        });
        finalResult = await finalizeSession({ page: session.page, timeoutMs });
      }
      update({ type: `registration.${finalResult.step}`, status: 'succeeded', step: finalResult.step, result: finalResult });
      await savePageSnapshot({
        page: session.page,
        evidence,
        update,
        label: 'session-finalized',
        step: 'session_finalized_snapshot',
      });
      const cookies = await session.context.cookies().catch(() => []);
      const sessionCookie = findSessionCookie(cookies);
      const registrationEnvironment = {
        taskId,
        proxyAttempt: registrationProxyAttempt,
        proxyPoolId: mainProxyPoolId || null,
        proxy: registrationProxy ? {
          id: registrationProxy.id,
          country: registrationProxy.country,
          host: registrationProxy.host,
          port: registrationProxy.port,
          poolId: registrationProxy.poolId || mainProxyPoolId || null,
        } : null,
        browser: {
          headless: this.config.browser.headless,
          geoip: this.config.browser.geoip,
        },
      };
      let postRegistrationBootstrap = null;
      try {
        postRegistrationBootstrap = await collectPostRegistrationBootstrap({
          page: session.page,
          email: task.email,
          timeoutMs,
          registrationEnvironment,
          checkEligibility: registrationExtras.autoCheckEligibility === true,
        });
        update({
          type: 'registration.post_registration_bootstrap_completed',
          status: 'succeeded',
          step: 'post_registration_bootstrap_completed',
          result: publicPostRegistrationBootstrapResult(postRegistrationBootstrap),
        });
      } catch (error) {
        const postRegistrationBootstrapError = {
          code: error?.code || 'POST_REGISTRATION_BOOTSTRAP_FAILED',
          status: error?.status || null,
          message: String(error?.message || error),
        };
        update({
          type: 'registration.post_registration_bootstrap_failed',
          status: 'failed',
          step: 'post_registration_bootstrap_failed',
          error: postRegistrationBootstrapError,
        });
        throw error;
      }
      let totpSetup = null;
      let totpSetupError = null;
      if (registrationExtras.setupTotp2fa === true && postRegistrationBootstrap?.accessToken) {
        try {
          totpSetup = await setupTotp2fa({
            page: session.page,
            accessToken: postRegistrationBootstrap.accessToken,
            timeoutMs,
          });
          update({
            type: 'registration.twofa_setup_completed',
            status: 'succeeded',
            step: 'twofa_setup_completed',
            result: {
              alreadyEnabled: Boolean(totpSetup.alreadyEnabled),
              activeFactorId: totpSetup.activeFactorId || null,
            },
          });
        } catch (error) {
          totpSetupError = {
            code: error?.code || 'TOTP_2FA_SETUP_FAILED',
            status: error?.status || null,
            message: String(error?.message || error),
          };
          update({
            type: 'registration.twofa_setup_failed',
            status: 'failed',
            step: 'twofa_setup_failed',
            error: totpSetupError,
          });
          throw error;
        }
      } else if (registrationExtras.setupTotp2fa === true) {
        totpSetupError = {
          code: 'TOTP_2FA_ACCESS_TOKEN_UNAVAILABLE',
          status: null,
          message: '2FA setup skipped because post-registration access token was unavailable',
        };
        update({
          type: 'registration.twofa_setup_skipped',
          status: 'failed',
          step: 'twofa_setup_skipped',
          error: totpSetupError,
        });
        const error = new Error(totpSetupError.message);
        error.code = totpSetupError.code;
        error.retryableProxy = false;
        throw error;
      } else {
        update({
          type: 'registration.twofa_setup_skipped',
          status: 'succeeded',
          step: 'twofa_setup_skipped',
          result: { reason: 'registration_extra_setupTotp2fa_disabled' },
        });
      }
      const completedAccount = {
        status: 'registered',
        lastTaskId: taskId,
        password: task.registrationPassword,
        passwordStatus,
        passwordStatusSource: 'registration_flow',
        passwordStatusUpdatedAt: new Date().toISOString(),
        sessionAvailable: Boolean(sessionCookie?.value),
        session: {
          cookies,
          capturedAt: new Date().toISOString(),
          sourceTaskId: taskId,
        },
        registrationEnvironment,
        tokens: {
          accessToken: postRegistrationBootstrap.accessToken,
          refreshedAt: postRegistrationBootstrap.checkedAt,
        },
        accessTokenLastRefreshedAt: postRegistrationBootstrap.checkedAt,
        eligibilityStatus: postRegistrationBootstrap.trialEligibility?.status || 'unknown',
        trialEligibility: postRegistrationBootstrap.trialEligibility || null,
        eligibilityLastResult: postRegistrationBootstrap.eligibilityChecked
          ? publicPostRegistrationBootstrapResult(postRegistrationBootstrap)
          : null,
        eligibilityLastCheckedAt: postRegistrationBootstrap.eligibilityChecked
          ? postRegistrationBootstrap.checkedAt
          : null,
        ...(totpSetup ? {
          hasTotp: true,
          ...(totpSetup.secret ? { totpSecret: totpSetup.secret } : {}),
          totpSetupAt: new Date().toISOString(),
          totpSetupError: null,
        } : totpSetupError ? {
          totpSetupError,
        } : {}),
      };
      await flushEvents();
      stopLeaseHeartbeat();
      await this.finishRegistration({
              guard,
        jobId: taskId,
        account: completedAccount,
        event: { branch: this.entryBranchForTask(task) },
      });
      guard.allowTerminal = true;
      await this.recordTerminalMailComDomainResult(task, { ok: true, trialEligibility: completedAccount.trialEligibility || null });
      const release = await this.releaseTerminalMailComAlias(task, update);
      await this.transitionTerminalMailComWorkflow(task, {
        release,
        trialEligibility: completedAccount.trialEligibility || null,
      });
      await recordEvidence({
        type: 'registration.completed',
        payload: { status: 'succeeded', step: 'completed' },
      });
    } catch (error) {
      stopLeaseHeartbeat();
      if (leaseError || error?.code === 'REGISTRATION_WORKER_LEASE_LOST') throw loseLease(error);
      await this.assertTaskLease(task);
      if (task.mode === 'credential_repair') {
        update({
          type: 'credential_repair.failed',
          status: 'failed',
          step: 'credential_repair_failed',
          error: { code: error?.code || 'CREDENTIAL_REPAIR_FAILED', message: String(error?.message || error) },
        });
        await flushEvents();
        if (error?.code === 'MAILBOX_CODE_TIMEOUT') {
          await this.registrationStore.recordMailboxDeliveryFailure?.({
            guard,
            accountId: task.accountId,
            detail: 'credential_repair_otp_delivery_timeout',
          });
        }
        const repairTerminal = error?.code === 'CREDENTIAL_REPAIR_UNKNOWN_MFA';
        await this.accountAssetStore.updateByEmail({
          email: task.email,
          guard,
          patch: {
            workflowStage: repairTerminal ? 'unrepairable' : 'repair',
            mailComStage: repairTerminal ? 'unrepairable' : 'repair',
            credentialRepair: {
              status: 'failed',
              taskId,
              error: { code: error?.code || 'CREDENTIAL_REPAIR_FAILED', message: String(error?.message || error) },
              failedAt: new Date().toISOString(),
            },
          },
        });
        return;
      }
      const persistedJob = await this.registrationStore.loadJob({ jobId: taskId });
      if (persistedJob?.status === 'completed') {
        await recordEvidence({
          type: 'registration.completion_response_failed',
          payload: {
            taskId,
            error: { code: error?.code || 'COMPLETION_RESPONSE_FAILED', message: String(error?.message || error) },
          },
        });
        return;
      }
      update({
        type: 'registration.failed',
        status: 'failed',
        step: 'failed',
        error: {
          code: error?.code || 'REGISTRATION_FAILED',
          message: String(error?.message || error),
        },
      });
      await flushEvents();
      if (error?.code === 'MAILBOX_CODE_TIMEOUT') {
        await this.registrationStore.recordMailboxDeliveryFailure?.({
            guard,
          accountId: task.accountId,
          detail: 'registration_otp_delivery_timeout',
        });
      }
      const failedAccount = await this.accountAssetStore.getByJob(taskId);
      await this.accountAssetStore.abandonScratchByEmail(failedAccount?.email || task.email, { guard });
      await this.recordTerminalMailComDomainResult(task, { ok: false, error });
      const release = await this.releaseTerminalMailComAlias(task, update);
      await this.transitionTerminalMailComWorkflow(task, { release, registrationFailed: true });
    } finally {
      stopLeaseHeartbeat();
      try { await session?.close?.(); } catch {}
      this.running.delete(taskId);
      await recordEvidence({ type: 'registration.runner_closed', payload: { taskId } });
      await flushEvents();
    }
  }
}

module.exports = {
  RegistrationRunner,
  RegistrationPasswordBranchError,
  assertConfiguredRegistrationCompletion,
  isProtocolEntryBranch,
  isFreeppSidecarEntryBranch,
};
