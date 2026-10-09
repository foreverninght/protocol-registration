'use strict';

const { randomBytes, randomUUID } = require('node:crypto');

const { createMailComSplitAddress } = require('./providers/mail-com-split');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizePrefix(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
}

function errorSummary(error) {
  return {
    code: normalizeText(error?.code) || 'MAIL_COM_REGISTRATION_CONTROL_FAILED',
    message: normalizeText(error?.message || error).slice(0, 1000),
  };
}

function candidateAddress(prefix, domain) {
  const randomPart = randomBytes(8).toString('hex').slice(0, 8);
  return `${prefix}${randomPart}@${domain}`;
}


class MailComRegistrationControl {
  constructor({
    mailboxStore,
    registrationStore,
    runner,
    registrationPassword,
    createAddress = createMailComSplitAddress,
    aliasLimit = 9,
    queueSource = 'mail_com_split',
    entryBranch = 'freepp',
    getConcurrency = null,
    getTaskOptions = null,
    queuePollIntervalMs = 1000,
    refillDelayMs = 300,
    workerId = `mail-com-registration-control:${process.pid}`,
    leaseMs = 300000,
    onError = null,
    onMailboxConflict = null,
  }) {
    if (!mailboxStore || !registrationStore || !runner) {
      throw new TypeError('mailboxStore, registrationStore, and runner are required');
    }
    this.mailboxStore = mailboxStore;
    this.registrationStore = registrationStore;
    this.runner = runner;
    this.registrationPassword = registrationPassword;
    this.createAddress = createAddress;
    this.aliasLimit = Math.max(1, Math.trunc(Number(aliasLimit) || 9));
    this.queueSource = normalizeText(queueSource).toLowerCase();
    this.entryBranch = normalizeText(entryBranch).toLowerCase() || 'freepp';
    this.getConcurrency = typeof getConcurrency === 'function' ? getConcurrency : null;
    this.getTaskOptions = typeof getTaskOptions === 'function' ? getTaskOptions : null;
    this.queuePollIntervalMs = Math.max(250, Math.trunc(Number(queuePollIntervalMs) || 1000));
    this.refillDelayMs = Math.max(0, Math.trunc(Number(refillDelayMs) || 300));
    this.workerId = normalizeText(workerId);
    if (!this.workerId) throw new TypeError('mail.com registration control workerId is required');
    this.leaseMs = Math.max(30000, Math.min(3600000, Math.trunc(Number(leaseMs) || 300000)));
    this.onError = typeof onError === 'function' ? onError : null;
    this.onMailboxConflict = typeof onMailboxConflict === 'function' ? onMailboxConflict : null;
    this.activeRuns = new Map();
    this.stopped = false;
    this.stopWaiters = new Set();
    this.queuePollTimer = null;
    this.refillTimer = null;
    this.dbDrainRunning = false;
    this.lastLeaseRecoveryAt = 0;
    this.initialLeaseRecoveryDone = false;
    this.leaseRecoveryIntervalMs = 30000;
    this.lastMailboxRepairCheckAt = 0;
    this.mailboxRepairCheckIntervalMs = 15000;
    this.mailboxRepairCheckRunning = false;
    this.refillRunning = false;
    this.preferredRefillMailboxId = '';
    this.preferredRefillOptions = {};
    this.lastRefillRun = null;
    this.lastError = null;
  }

  async settings() {
    return this.mailboxStore.getPoolSettings();
  }

  async target() {
    return (await this.settings()).targetCount;
  }

  async concurrency() {
    const configured = (await this.settings()).concurrency;
    if (!this.getConcurrency) return configured;
    const current = Number(this.getConcurrency());
    return Number.isFinite(current)
      ? Math.max(0, Math.min(configured, Math.trunc(current)))
      : configured;
  }

  async autoEnabled() {
    return (await this.settings()).enabled;
  }

  startQueuePolling() {
    if (this.stopped || this.queuePollTimer) return;
    this.queuePollTimer = setInterval(() => {
      this.drainDatabaseQueue().catch((error) => this.#recordBackgroundError(error, 'queue_poll'));
    }, this.queuePollIntervalMs);
    this.queuePollTimer.unref?.();
    this.drainDatabaseQueue().catch((error) => this.#recordBackgroundError(error, 'queue_start'));
  }

  stopQueuePolling() {
    if (this.queuePollTimer) clearInterval(this.queuePollTimer);
    this.queuePollTimer = null;
  }

  stop() {
    this.stopped = true;
    this.stopQueuePolling();
    if (this.refillTimer) clearTimeout(this.refillTimer);
    this.refillTimer = null;
    this.preferredRefillMailboxId = '';
    this.preferredRefillOptions = {};
    return new Promise((resolve) => {
      this.stopWaiters.add(resolve);
      this.#notifyStopped();
    });
  }

  #notifyStopped() {
    if (!this.stopped || this.dbDrainRunning || this.refillRunning || this.mailboxRepairCheckRunning || this.activeRuns.size) return;
    for (const resolve of this.stopWaiters) resolve();
    this.stopWaiters.clear();
  }

  scheduleTask() {
    if (this.stopped) return;
    this.drainDatabaseQueue().catch((error) => this.#recordBackgroundError(error, 'queue_notify'));
  }

  async drainDatabaseQueue() {
    if (this.stopped || this.dbDrainRunning) return { claimed: 0 };
    this.dbDrainRunning = true;
    let claimedCount = 0;
    try {
      const now = Date.now();
      if (!this.initialLeaseRecoveryDone) {
        await this.registrationStore.recoverExpiredJobs?.({
          reason: 'startup recovered a previous service worker lease',
          currentWorkerId: this.workerId,
        });
        this.initialLeaseRecoveryDone = true;
        this.lastLeaseRecoveryAt = now;
      }
      if (now - this.lastLeaseRecoveryAt >= this.leaseRecoveryIntervalMs) {
        this.lastLeaseRecoveryAt = now;
        await this.registrationStore.recoverExpiredJobs?.({
          reason: 'global queue poll recovered an expired worker lease',
        });
      }
      if (now - this.lastMailboxRepairCheckAt >= this.mailboxRepairCheckIntervalMs) {
        this.lastMailboxRepairCheckAt = now;
        await this.registrationStore.cancelStaleCredentialRepairJobs?.();
        this.#refreshMailboxRepairability()
          .catch((error) => this.#recordBackgroundError(error, 'mailbox_repairability'));
      }
      const concurrency = await this.concurrency();
      const repairLimit = Math.max(1, Math.ceil(concurrency * 0.25));
      let activeRepairCount = typeof this.registrationStore.countActiveJobs === 'function'
        ? await this.registrationStore.countActiveJobs({ mode: 'credential_repair' })
        : 0;
      while (!this.stopped && this.activeRuns.size < concurrency) {
        const registerOnly = activeRepairCount >= repairLimit;
        let claimed = await this.registrationStore.claimNextJob({
          mailboxSource: this.queueSource,
          mode: registerOnly ? 'register' : '',
          workerId: this.workerId,
          leaseMs: this.leaseMs,
        });
        if (!claimed && !this.stopped && await this.autoEnabled()) {
          const staged = await this.#stageReadyCandidate();
          if (staged) {
            claimed = await this.registrationStore.claimNextJob({
              mailboxSource: this.queueSource,
              mode: registerOnly ? 'register' : '',
              workerId: this.workerId,
              leaseMs: this.leaseMs,
            });
          }
        }
        if (!claimed) {
          let repair = null;
          if (!this.stopped && await this.autoEnabled()) {
            const repairOptions = this.getTaskOptions ? await this.getTaskOptions() : {};
            repair = await this.registrationStore.createCredentialRepairJob?.({
              automatic: true,
              proxyPoolId: normalizeText(repairOptions.proxyPoolId) || null,
            });
          }
          if (repair || registerOnly) {
            claimed = await this.registrationStore.claimNextJob({
              mailboxSource: this.queueSource,
              workerId: this.workerId,
              leaseMs: this.leaseMs,
            });
          }
        }
        if (!claimed) break;
        if (this.stopped) {
          await this.registrationStore.releaseClaim({
            jobId: claimed.id, workerId: this.workerId, attemptCount: claimed.attemptCount,
          });
          break;
        }
        claimedCount += 1;
        if (claimed.mode === 'credential_repair') activeRepairCount += 1;
        this.#startClaimedTask(claimed);
      }
      return { claimed: claimedCount };
    } finally {
      this.dbDrainRunning = false;
      this.#notifyStopped();
    }
  }

  async recheckMailboxRepairability({ emails = [], limit = 12 } = {}) {
    if (this.mailboxRepairCheckRunning && Array.isArray(emails) && emails.length) {
      const deadline = Date.now() + 12000;
      while (this.mailboxRepairCheckRunning && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (this.stopped || this.mailboxRepairCheckRunning
      || typeof this.registrationStore.listMailboxRepairabilityChecks !== 'function'
      || typeof this.registrationStore.recordMailboxRepairability !== 'function') {
      return { busy: true, checked: 0, available: 0, expired: 0, unreachable: 0 };
    }
    this.mailboxRepairCheckRunning = true;
    const summary = { busy: false, checked: 0, available: 0, expired: 0, unreachable: 0 };
    try {
      const checks = await this.registrationStore.listMailboxRepairabilityChecks({ limit, emails });
      let index = 0;
      const worker = async () => {
        while (!this.stopped && index < checks.length) {
          const check = checks[index];
          index += 1;
          let status = 'unreachable';
          let detail = 'network_error';
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);
          timeout.unref?.();
          try {
            const response = await fetch(check.mailboxUrl, { signal: controller.signal });
            const body = (await response.text()).slice(0, 1000).toLowerCase();
            const invalidBody = /not found|expired|invalid inbox|inbox.*not.*exist|已失效|不存在/u.test(body);
            if (response.ok && !invalidBody) {
              status = 'available';
              detail = `http_${response.status}`;
            } else if ([404, 410].includes(response.status) || invalidBody) {
              status = 'expired';
              detail = `http_${response.status}`;
            } else {
              detail = `http_${response.status}`;
            }
          } catch (error) {
            detail = error?.name === 'AbortError' ? 'timeout' : 'network_error';
          } finally {
            clearTimeout(timeout);
          }
          await this.registrationStore.recordMailboxRepairability({
            accountId: check.accountId,
            status,
            detail,
          });
          summary.checked += 1;
          summary[status] += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(12, checks.length) }, worker));
      return summary;
    } finally {
      this.mailboxRepairCheckRunning = false;
      this.#notifyStopped();
    }
  }

  async #refreshMailboxRepairability() {
    await this.recheckMailboxRepairability({ limit: 12 });
  }

  #startClaimedTask(task) {
    const taskId = normalizeText(task?.id);
    if (!taskId || this.activeRuns.has(taskId)) {
      throw new Error(`claimed registration task is invalid or already active: ${taskId}`);
    }
    const running = Promise.resolve(this.runner.runClaimed(task));
    this.activeRuns.set(taskId, running);
    running
      .catch((error) => this.#recordBackgroundError(error, 'registration_run', { taskId }))
      .finally(() => {
        this.activeRuns.delete(taskId);
        this.#notifyStopped();
        if (this.stopped) return;
        this.drainDatabaseQueue().catch((error) => this.#recordBackgroundError(error, 'queue_continue'));
        if (task.mailboxSource === 'mail_com_split') {
          this.scheduleGlobalRefill(task.mailboxId || '', {
            proxyPoolId: normalizeText(task.proxyPoolId) || null,
            browserEngine: normalizeText(task.browserEngine).toLowerCase() || null,
          });
        }
      });
  }

  async #stageReadyCandidate() {
    const retryOptions = this.getTaskOptions ? await this.getTaskOptions() : {};
    const retried = await this.registrationStore.retryNextRepairableRegistration?.({
      proxyPoolId: normalizeText(retryOptions.proxyPoolId) || null,
      entryBranch: normalizeText(retryOptions.entryBranch).toLowerCase() || this.entryBranch,
    });
    if (retried) return true;
    const candidates = await this.registrationStore.listCandidates({ status: 'ready' });
    for (const candidate of [...candidates].reverse()) {
      if (candidate.mailboxSource === 'mail_com_split') continue;
      const mailbox = await this.runner.mailboxProviderForTask(candidate);
      if (!mailbox?.provider) continue;
      const taskOptions = this.getTaskOptions ? await this.getTaskOptions(candidate) : {};
      const password = typeof this.registrationPassword === 'function'
        ? await this.registrationPassword()
        : this.registrationPassword;
      try {
        await this.registrationStore.createJob({
          id: randomUUID(),
          email: candidate.email,
          registrationPassword: password,
          mailboxSource: candidate.mailboxSource,
          mailboxUrl: candidate.mailboxUrl,
          proxyPoolId: normalizeText(taskOptions.proxyPoolId) || null,
          browserEngine: normalizeText(taskOptions.browserEngine).toLowerCase() || null,
          entryBranch: normalizeText(taskOptions.entryBranch).toLowerCase() || this.entryBranch,
          mode: 'register',
          options: {},
        });
        return true;
      } catch (error) {
        if (!['REGISTRATION_CANDIDATE_ALREADY_STARTED', 'REGISTRATION_CANDIDATE_CONSUME_CONFLICT'].includes(error?.code)) throw error;
      }
    }
    return false;
  }

  stopAutoRefill() {
    if (this.refillTimer) clearTimeout(this.refillTimer);
    this.refillTimer = null;
    this.preferredRefillMailboxId = '';
    this.preferredRefillOptions = {};
  }

  scheduleGlobalRefill(preferredMailboxId = '', options = {}) {
    if (this.stopped) return;
    if (preferredMailboxId) this.preferredRefillMailboxId = normalizeText(preferredMailboxId);
    if (options && typeof options === 'object' && Object.keys(options).length) {
      this.preferredRefillOptions = {
        ...this.preferredRefillOptions,
        ...options,
      };
    }
    if (this.refillTimer || this.refillRunning) return;
    this.refillTimer = setTimeout(async () => {
      this.refillTimer = null;
      try {
        if (this.stopped || !await this.autoEnabled()) return;
        const preferred = this.preferredRefillMailboxId;
        const refillOptions = this.preferredRefillOptions;
        this.preferredRefillMailboxId = '';
        this.preferredRefillOptions = {};
        await this.refill({ preferredMailboxId: preferred, options: refillOptions });
      } catch (error) {
        this.#recordBackgroundError(error, 'auto_refill');
      }
    }, this.refillDelayMs);
    this.refillTimer.unref?.();
  }

  async refill({ preferredMailboxId = '', options = {} } = {}) {
    if (this.stopped) throw Object.assign(new Error('registration control is stopped'), { code: 'REGISTRATION_CONTROL_STOPPED' });
    if (this.refillRunning) {
      const error = new Error('mail.com alias refill is already running in this process');
      error.code = 'ALIAS_REFILL_ALREADY_ACTIVE';
      throw error;
    }
    this.refillRunning = true;
    let run = null;
    let runStarted = false;
    let terminalError = null;
    try {
      run = await this.mailboxStore.createRefillRun({ preferredMailboxId, options });
      run = await this.mailboxStore.startRefillRun({ refillRunId: run.id });
      runStarted = true;
      let remaining = Math.max(0, run.targetCount - run.initialPoolCount);
      if (remaining > 0) {
        const mailboxes = await this.#openMailboxes(preferredMailboxId);
        if (!mailboxes.length) {
          const error = new Error('no user-opened mail.com mailbox session is available');
          error.code = 'MAIL_COM_OPEN_SESSION_REQUIRED';
          throw error;
        }
        const contexts = mailboxes.map((mailbox) => ({ mailbox }));
        let progress = true;
        while (!this.stopped && remaining > 0 && progress) {
          progress = false;
          for (const context of contexts) {
            if (this.stopped || remaining <= 0) break;
            const staged = await this.#stageOne({ run, context, options });
            if (!staged) continue;
            remaining -= 1;
            progress = true;
          }
        }
        if (remaining > 0) {
          const error = new Error(`opened mail.com sessions could not supply ${remaining} required aliases`);
          error.code = 'MAIL_COM_REFILL_TARGET_NOT_REACHED';
          terminalError = error;
        }
      }
      await this.mailboxStore.queueRefillRunJobs({ refillRunId: run.id });
    } catch (error) {
      terminalError = error;
    } finally {
      try {
        if (runStarted) this.lastRefillRun = await this.mailboxStore.finishRefillRun({ refillRunId: run.id, error: terminalError });
      } finally {
        this.refillRunning = false;
        this.#notifyStopped();
      }
    }
    if (!run) throw terminalError;
    this.scheduleTask();
    return this.lastRefillRun;
  }

  async #openMailboxes(preferredMailboxId) {
    const mailboxes = (await this.mailboxStore.listMailboxes({ provider: 'mail_com', includeSecret: false }))
      .filter((mailbox) => mailbox.sessionStatus === 'open');
    const preferred = normalizeText(preferredMailboxId);
    if (!preferred) return mailboxes;
    return [
      ...mailboxes.filter((mailbox) => mailbox.id === preferred),
      ...mailboxes.filter((mailbox) => mailbox.id !== preferred),
    ];
  }

  async #stageOne({ run, context, options }) {
    const existing = await this.mailboxStore.reserveExistingAliasForRefill({
      refillRunId: run.id,
      mailboxId: context.mailbox.id,
    });
    if (existing) return this.#createStagedJob({ run, reservation: existing, options });
    const currentMailbox = await this.mailboxStore.getMailbox({ mailboxId: context.mailbox.id });
    if (!currentMailbox || currentMailbox.retiredAt || currentMailbox.aliasCount >= this.aliasLimit) return null;

    let reservation = null;
    for (let attempt = 0; attempt < 12 && !reservation; attempt += 1) {
      let selectedDomain;
      try {
        selectedDomain = await this.mailboxStore.reserveMailComDomain();
      } catch (error) {
        if (error?.code === 'MAIL_COM_SPLIT_DOMAIN_UNAVAILABLE') return null;
        throw error;
      }
      const email = candidateAddress(normalizePrefix(options.usernamePrefix), selectedDomain.domain);
      try {
        reservation = await this.mailboxStore.reserveAliasForRefill({
          refillRunId: run.id,
          mailboxId: context.mailbox.id,
          email,
        });
      } catch (error) {
        if (error?.code !== '23505' && error?.code !== 'ALIAS_ALREADY_EXISTS') throw error;
      }
    }
    if (!reservation) return null;

    try {
      await this.mailboxStore.markAliasCreating({
        aliasId: reservation.alias.id,
        refillItemId: reservation.item.id,
      });
      await this.createAddress({
        mailboxStore: this.mailboxStore,
        mailboxId: context.mailbox.id,
        aliasId: reservation.alias.id,
        timeoutMs: options.timeoutMs,
      });
      await this.mailboxStore.markAliasCreated({
        aliasId: reservation.alias.id,
        refillItemId: reservation.item.id,
      });
      return await this.#createStagedJob({ run, reservation, options });
    } catch (error) {
      await this.mailboxStore.failRefillItem({
        aliasId: reservation.alias.id,
        refillItemId: reservation.item.id,
        error,
        cleanupRequired: true,
      });
      if (this.onMailboxConflict) await this.onMailboxConflict(context.mailbox, error);
      return null;
    }
  }

  async #createStagedJob({ run, reservation, options }) {
    const password = typeof this.registrationPassword === 'function'
      ? await this.registrationPassword()
      : this.registrationPassword;
    if (!normalizeText(password)) {
      const error = new Error('registration password is required before staging mail.com tasks');
      error.code = 'REGISTRATION_PASSWORD_REQUIRED';
      await this.mailboxStore.failRefillItem({
        aliasId: reservation.alias.id,
        refillItemId: reservation.item.id,
        error,
        cleanupRequired: reservation.existing === false,
      });
      return null;
    }
    try {
      const job = await this.registrationStore.createRefillJob({
        id: randomUUID(),
        refillItemId: reservation.item.id,
        email: reservation.alias.email,
        registrationPassword: password,
        mailboxSource: 'mail_com_split',
        mailboxId: reservation.alias.mailboxId,
        aliasId: reservation.alias.id,
        proxyPoolId: normalizeText(options.proxyPoolId) || null,
        browserEngine: normalizeText(options.browserEngine).toLowerCase() || null,
        entryBranch: this.entryBranch,
        options: {
          refillRunId: run.id,
          refillItemId: reservation.item.id,
        },
        staged: true,
      });
      return job;
    } catch (error) {
      await this.mailboxStore.failRefillItem({
        aliasId: reservation.alias.id,
        refillItemId: reservation.item.id,
        error,
        cleanupRequired: reservation.existing === false,
      });
      return null;
    }
  }

  async snapshot() {
    const settings = await this.settings();
    const effectiveConcurrency = await this.concurrency();
    const readyCandidates = await this.registrationStore.listCandidates({ status: 'ready' });
    const readyBySource = readyCandidates.reduce((counts, candidate) => ({
      ...counts,
      [candidate.mailboxSource]: Number(counts[candidate.mailboxSource] || 0) + 1,
    }), {});
    return {
      autoEnabled: settings.enabled,
      target: settings.targetCount,
      concurrency: settings.concurrency,
      effectiveConcurrency,
      admissionOpen: effectiveConcurrency > 0,
      availableSlots: Math.max(0, effectiveConcurrency - this.activeRuns.size),
      running: this.activeRuns.size,
      ready: readyCandidates.length,
      readyBySource,
      dbQueuePolling: Boolean(this.queuePollTimer),
      dbDrainRunning: this.dbDrainRunning,
      refillScheduled: Boolean(this.refillTimer),
      refillRunning: this.refillRunning,
      preferredRefillMailboxId: this.preferredRefillMailboxId,
      preferredRefillProxyPoolId: normalizeText(this.preferredRefillOptions.proxyPoolId) || null,
      lastRefillRun: this.lastRefillRun,
      lastError: this.lastError,
    };
  }

  #recordBackgroundError(error, operation, details = {}) {
    this.lastError = { ...errorSummary(error), operation, ...details, at: new Date().toISOString() };
    if (this.onError) this.onError(error, { operation, ...details });
  }
}

module.exports = { MailComRegistrationControl, candidateAddress };
