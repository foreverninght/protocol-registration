const api = {
  async parseError(res) {
    let detail = '';
    try {
      const payload = await res.json();
      detail = payload.workerBody || payload.message || payload.error || '';
    } catch {
      try { detail = await res.text(); } catch {}
    }
    return new Error(`${res.status} ${res.statusText}${detail ? ` · ${detail}` : ''}`.trim());
  },
  async get(path) {
    assertApiCapability(path);
    let res = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        res = await fetch(path, { cache: 'no-store' });
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
    }
    if (!res) throw lastError || new Error('服务连接失败');
    if (!res.ok) throw await this.parseError(res);
    return res.json();
  },
  async post(path, body) {
    assertApiCapability(path);
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.parseError(res);
    return res.json();
  },
  async put(path, body) {
    assertApiCapability(path);
    const res = await fetch(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await this.parseError(res);
    return res.json();
  },
  async delete(path) {
    assertApiCapability(path);
    const res = await fetch(path, { method: 'DELETE' });
    if (!res.ok) throw await this.parseError(res);
    return res.json();
  },
};

const $ = (id) => document.getElementById(id);
const state = {
  config: null,
  tasks: [],
  emails: [],
  accounts: [],
  registrationView: { byEmail: {}, summary: {} },
  proxyCatalog: {},
  paymentSettings: null,
  paymentMethodProbeSettings: null,
  registrationChangeEmailSettings: null,
  phoneBindSettings: null,
  pipelineConcurrency: null,
  registrationChangeEmailDraftDirty: false,
  paymentDraftDirty: false,
  paymentMethodProbeDraftDirty: false,
  phoneBindSettingsDraftDirty: false,
  cfMailbox: null,
  cfMailboxDraftDirty: false,
  cfDomainOptions: [],
  cfRandomSubdomainOptions: null,
  mailComAccounts: [],
  mailComDomainSignature: '',
  mailComAliasDrafts: {},
  mailComAliasDomains: JSON.parse(localStorage.getItem('mailComAliasDomains') || '{}'),
  collapsedMailComAccountIds: new Set(JSON.parse(localStorage.getItem('collapsedMailComAccountIds') || '[]')),
  mailComStartedManagerOpen: localStorage.getItem('mailComStartedManagerOpen') !== 'false',
  mailComManagerOpen: localStorage.getItem('mailComManagerOpen') === 'true',
  mailComDraft: {
    mainImport: '',
  },
  lastMailComAutoStart: null,
  mailComFeedbackMessage: '',
  mailComAccountFeedbacks: {},
  mailComBusyAccountIds: new Set(),
  mailComSessionOverrides: {},
  mailRunDisplayOrder: JSON.parse(localStorage.getItem('mailRunDisplayOrder') || '[]'),
  refining: null,
  refiningCapabilities: null,
  refiningServiceOnline: false,
  refiningDraftDirty: false,
  selectedProxyPools: JSON.parse(localStorage.getItem('selectedProxyPools') || '{}'),
  selectedExecutionType: localStorage.getItem('selectedExecutionType') || '',
  selectedBrowserEngine: localStorage.getItem('selectedBrowserEngine') || '',
  selectedEntryBranch: localStorage.getItem('selectedEntryBranch') || 'freepp',
  selectedEmailIds: new Set(),
  selectedWorkflowEmails: new Set(),
  bulkWorkflowActionRunning: false,
  activeTaskStarts: new Set(),
  activeRefiningStarts: new Set(),
  activeGcashRefiningStarts: new Set(),
  activeAccountStatusChecks: new Set(),
  activePaymentMethodProbeStarts: new Set(),
  mailRunAccountFeedbacks: {},
  activePaymentStarts: new Set(),
  activePhoneBindStarts: new Set(),
  activeRefreshTokenStarts: new Set(),
  activeSessionCookieRenewals: new Set(),
    activeMailWorkflowRows: [],
    visibleMailWorkflowRows: [],
    mailWorkflowRefiningQuery: localStorage.getItem('mailWorkflowRefiningQuery') || '',
    soldWorkflowSubstage: ['unsms', 'sms'].includes(localStorage.getItem('soldWorkflowSubstage'))
      ? localStorage.getItem('soldWorkflowSubstage')
      : 'unsms',
    bulkCopyingAccessTokens: false,
    bulkCopyingCredentials: false,
    bulkCheckingAccessTokens: false,
    bulkCopyingRefreshTokens: false,
    bulkMovingCompletedToSold: false,
  manualPhoneBindEmails: new Set(),
  refreshing: false,
  refreshQueued: false,
  autoRefreshSuspendedUntil: 0,
  userInteractionRevision: 0,
  frontendAssetVersion: '',
  frontendUpdateAvailable: false,
  phoneBindDrafts: JSON.parse(localStorage.getItem('phoneBindDrafts') || '{}'),
  expandedTaskIds: new Set(),
  eventScroll: new Map(),
  activeTab: 'run',
  activeRunCategory: localStorage.getItem('activeRunCategory') || 'ic',
  activeMailCategory: localStorage.getItem('activeMailCategory') || 'ic',
  activeMailWorkflowStage: ['preparing', 'registering', 'repair', 'eligibility', 'discarded', 'payment_method', 'refining', 'unpaid', 'paid', 'completed', 'sold'].includes(localStorage.getItem('activeMailWorkflowStage'))
    ? localStorage.getItem('activeMailWorkflowStage')
    : 'preparing',
};

const MAIL_WORKFLOW_STAGES = ['preparing', 'registering', 'repair', 'repair_verification', 'unrepairable', 'eligibility', 'discarded', 'payment_method', 'refining', 'unpaid', 'paid', 'completed', 'sold'];
const DATE_GROUPED_MAIL_STAGES = new Set(MAIL_WORKFLOW_STAGES.filter((stage) => !['preparing', 'registering'].includes(stage)));
const AT_COPY_MAIL_STAGES = new Set(['eligibility', 'payment_method', 'refining']);
const ACCOUNT_COPY_MAIL_STAGES = new Set(['unpaid', 'paid', 'completed', 'sold']);
const MAIL_RUN_DISPLAY_ORDER_STORAGE_KEY = 'mailRunDisplayOrder';

function normalizeEmailKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

function syncMailRunDisplayOrder(entries = state.emails) {
  const liveKeys = new Set();
  const next = [];
  const seen = new Set();
  const saved = Array.isArray(state.mailRunDisplayOrder) ? state.mailRunDisplayOrder : [];
  for (const entry of entries || []) {
    const key = normalizeEmailKey(entry?.email);
    if (key) liveKeys.add(key);
  }
  for (const value of saved) {
    const key = normalizeEmailKey(value);
    if (!key || seen.has(key) || !liveKeys.has(key)) continue;
    seen.add(key);
    next.push(key);
  }
  for (const entry of entries || []) {
    const key = normalizeEmailKey(entry?.email);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(key);
  }
  state.mailRunDisplayOrder = next;
  try {
    localStorage.setItem(MAIL_RUN_DISPLAY_ORDER_STORAGE_KEY, JSON.stringify(next));
  } catch {}
  return new Map(next.map((email, index) => [email, index]));
}

function stableMailRunRows(rows, orderMap) {
  const fallback = Number.MAX_SAFE_INTEGER;
  return (Array.isArray(rows) ? rows : []).slice().sort((left, right) => {
    const leftKey = normalizeEmailKey(left?.entry?.email);
    const rightKey = normalizeEmailKey(right?.entry?.email);
    const leftOrder = orderMap?.has(leftKey) ? orderMap.get(leftKey) : fallback;
    const rightOrder = orderMap?.has(rightKey) ? orderMap.get(rightKey) : fallback;
    return leftOrder - rightOrder || leftKey.localeCompare(rightKey);
  });
}

function setMailRunAccountFeedback(email, message, { ttlMs = 120000 } = {}) {
  const key = normalizeEmailKey(email);
  if (!key) return;
  const text = String(message || '').trim();
  state.mailRunAccountFeedbacks = { ...(state.mailRunAccountFeedbacks || {}) };
  if (text) state.mailRunAccountFeedbacks[key] = { message: text, at: Date.now(), ttlMs };
  else delete state.mailRunAccountFeedbacks[key];
}

function registrationViewForEmail(email) {
  const key = normalizeEmailKey(email);
  return key ? state.registrationView?.byEmail?.[key] || null : null;
}

function registrationViewLabel(view) {
  return String(view?.label || view?.status || '').trim();
}

function registrationViewActivity(view) {
  if (!view) return '';
  const label = registrationViewLabel(view);
  if (!label || label === '未开始') return '';
  const detail = String(view.detail || '').trim();
  return detail ? `${label}：${shortStatusText(detail, 80)}` : label;
}

function registrationViewAction(view) {
  const action = String(view?.action || '').trim().toLowerCase();
  if (!view || !action || action === 'start') return { enabled: true, label: '启动' };
  if (action === 'retry') return { enabled: true, label: '重试' };
  return { enabled: false, label: view.actionLabel || registrationViewLabel(view) || '处理中' };
}

function mailRunAccountFeedback(email) {
  const key = normalizeEmailKey(email);
  const item = key ? state.mailRunAccountFeedbacks?.[key] : null;
  if (!item) return '';
  const message = typeof item === 'string' ? item : item.message;
  const at = Number(item.at || 0);
  const ttlMs = Math.max(1000, Number(item.ttlMs || 120000));
  if (at && Date.now() - at > ttlMs) {
    delete state.mailRunAccountFeedbacks[key];
    return '';
  }
  return String(message || '').trim();
}

function emptyWorkflowRows() {
  return Object.fromEntries(MAIL_WORKFLOW_STAGES.map((stage) => [stage, []]));
}

const POOL_CATEGORIES = ['main', 'eligibility', 'checkout', 'payment'];
const DIRECT_PROXY_VALUE = '__direct__';

function executionCatalog() {
  const catalog = state.config?.registration?.executionCatalog;
  return catalog && typeof catalog === 'object'
    ? catalog
    : { types: [], implementations: [], fingerprintBrowsers: [] };
}

function catalogItem(items, value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;
  return (Array.isArray(items) ? items : []).find((item) => (
    String(item?.key || '').toLowerCase() === text || String(item?.id) === text
  )) || null;
}

function executionTypeItem(value) {
  return catalogItem(executionCatalog().types, value);
}

function executionImplementationItem(value) {
  return catalogItem(executionCatalog().implementations, value);
}

function fingerprintBrowserItem(value) {
  return catalogItem(executionCatalog().fingerprintBrowsers, value);
}

function implementationsForType(type) {
  const key = executionTypeItem(type)?.key || '';
  return executionCatalog().implementations.filter((item) => item.type === key);
}

function selectedProxyPool(category) {
  const pools = state.proxyCatalog?.[category] || [];
  const selected = state.selectedProxyPools?.[category];
  if (selected && pools.some((pool) => pool.id === selected)) return selected;
  if (category === 'payment') {
    const configured = state.paymentSettings?.proxyPoolId || '';
    if (configured && pools.some((pool) => pool.id === configured)) return configured;
    const nonEmpty = pools.find((pool) => Number(pool.count || 0) > 0);
    if (nonEmpty) return nonEmpty.id;
  }
  if (category === 'main' || category === 'eligibility') {
    const preferred = pools.find((pool) => Array.isArray(pool.countries) && pool.countries.includes('GB'));
    if (preferred) return preferred.id;
  }
  return DIRECT_PROXY_VALUE;
}

let uiPreferenceSaveQueue = Promise.resolve();

function persistUiPreferences() {
  const snapshot = {
    proxyPools: state.selectedProxyPools,
    executionType: selectedExecutionType(),
    browserEngine: state.selectedBrowserEngine,
    entryBranch: state.selectedEntryBranch,
  };
  suspendAutoRefresh(EDITING_REFRESH_PAUSE_MS);
  uiPreferenceSaveQueue = uiPreferenceSaveQueue
    .catch(() => null)
    .then(() => api.put('/api/preferences', snapshot))
    .then((saved) => {
      if (state.config && saved && typeof saved === 'object') {
        state.config.preferences = { ...saved };
      }
      if (saved?.proxyPools && typeof saved.proxyPools === 'object') {
        state.selectedProxyPools = { ...state.selectedProxyPools, ...saved.proxyPools };
        localStorage.setItem('selectedProxyPools', JSON.stringify(state.selectedProxyPools));
      }
      return saved;
    });
  return uiPreferenceSaveQueue;
}

function setSelectedProxyPool(category, poolId) {
  state.selectedProxyPools = { ...state.selectedProxyPools, [category]: poolId || DIRECT_PROXY_VALUE };
  localStorage.setItem('selectedProxyPools', JSON.stringify(state.selectedProxyPools));
  void persistUiPreferences();
}

function proxyPoolPayload(category) {
  const value = selectedProxyPool(category);
  return value === DIRECT_PROXY_VALUE ? null : value;
}

function selectedBrowserEngine() {
  const engine = String(state.selectedBrowserEngine || '').trim().toLowerCase();
  return fingerprintBrowserItem(engine)?.key || '';
}

function browserEnginePayload() {
  if (!selectedExecutionTypeItem()?.usesFingerprintBrowser) return undefined;
  return selectedBrowserEngine() || undefined;
}

function browserEngineLabel(value) {
  return fingerprintBrowserItem(value)?.label || value || '服务默认';
}

function selectedEntryBranch() {
  const branch = String(state.selectedEntryBranch || '').trim().toLowerCase();
  return executionImplementationItem(branch)?.key || '';
}

function selectedExecutionTypeItem() {
  const explicit = executionTypeItem(state.selectedExecutionType);
  if (explicit) return explicit;
  const implementation = executionImplementationItem(selectedEntryBranch())
    || executionImplementationItem(state.config?.registration?.entryBranch);
  return executionTypeItem(implementation?.type || state.config?.registration?.executionType);
}

function selectedExecutionType() {
  return selectedExecutionTypeItem()?.key || '';
}

function registrationExecutionPayload() {
  const type = selectedExecutionTypeItem();
  const entryBranch = entryBranchPayload();
  if (!type) throw new Error('没有可用的执行类型');
  if (!entryBranch) throw new Error(`${type.label}类型尚未配置可执行实现`);
  return {
    executionType: type.key,
    entryBranch,
    ...(type.usesFingerprintBrowser ? { browserEngine: browserEnginePayload() } : {}),
  };
}

function entryBranchPayload() {
  const type = selectedExecutionType();
  const selected = executionImplementationItem(selectedEntryBranch());
  if (selected?.type === type) return selected.key;
  const service = executionImplementationItem(state.config?.registration?.entryBranch);
  if (service?.type === type) return service.key;
  return undefined;
}

function entryBranchLabel(value) {
  return executionImplementationItem(value)?.label || value || '服务默认';
}

async function copyTextToClipboard(text) {
  const value = String(text ?? '');
  if (!value) throw new Error('没有可复制的内容');
  if (navigator.clipboard?.writeText) {
    let timer = null;
    try {
      await Promise.race([
        navigator.clipboard.writeText(value),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('剪贴板写入超时')), 1200);
        }),
      ]);
      return;
    } catch {
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } catch {}
  textarea.remove();
  if (!copied) throw new Error('浏览器拒绝复制到剪贴板');
}

async function getSavedCopyValue(email, kind) {
  const basePath = `/api/accounts?a=${encodeURIComponent(email)}&b=${kind}`;
  const manifest = await api.get(basePath);
  const partCount = Number(manifest?.parts || 0);
  const expectedLength = Number(manifest?.length || 0);
  if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > 1000
    || !Number.isSafeInteger(expectedLength) || expectedLength < 1) {
    throw new Error('复制数据格式无效');
  }
  const parts = [];
  const concurrency = 8;
  for (let start = 0; start < partCount; start += concurrency) {
    const indexes = Array.from(
      { length: Math.min(concurrency, partCount - start) },
      (_, offset) => start + offset,
    );
    const batch = await Promise.all(indexes.map((index) => api.get(`${basePath}&c=${index}`)));
    parts.push(...batch);
  }
  parts.sort((left, right) => Number(left.index) - Number(right.index));
  const values = parts.flatMap((part) => Array.isArray(part?.data) ? part.data : []);
  const valid = values.length === expectedLength
    && values.every((value) => Number.isInteger(value) && value >= 0 && value <= 255);
  if (!valid) throw new Error('复制数据格式无效');
  return new TextDecoder().decode(Uint8Array.from(values));
}

async function getSavedAccessToken(email) {
  const normalized = String(email || '').trim();
  if (!normalized) return '';
  try {
    const result = await api.get(`/api/accounts/${encodeURIComponent(normalized)}/access-token`);
    return String(result?.accessToken || '');
  } catch (error) {
    return getSavedCopyValue(normalized, '1');
  }
}

async function getSavedRefreshToken(email) {
  return getSavedCopyValue(email, '2');
}

function showAccessTokenCopyFallback(accessToken, email, tokenLabel = 'AT', ariaLabel = 'Access Token') {
  const existing = document.getElementById('accessTokenCopyFallback');
  existing?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'accessTokenCopyFallback';
  overlay.className = 'copy-fallback-overlay';

  const panel = document.createElement('section');
  panel.className = 'copy-fallback-panel';

  const title = document.createElement('h3');
  title.textContent = `${tokenLabel}：${email}`;

  const input = document.createElement('textarea');
  input.className = 'copy-fallback-value';
  input.value = accessToken;
  input.readOnly = true;
  const lineCount = String(accessToken || '').split('\n').length;
  input.rows = lineCount > 1 ? Math.min(18, Math.max(6, lineCount)) : 4;
  input.setAttribute('aria-label', ariaLabel);

  const feedback = document.createElement('p');
  feedback.className = 'copy-fallback-feedback';
  feedback.textContent = '自动复制被浏览器拦截，请点击复制或按 Ctrl+C。';

  const actions = document.createElement('div');
  actions.className = 'button-row';

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = `复制 ${tokenLabel}`;
  copyButton.addEventListener('click', async () => {
    input.focus();
    input.select();
    try {
      await copyTextToClipboard(accessToken);
      feedback.textContent = `已复制 ${tokenLabel}。`;
    } catch (error) {
      feedback.textContent = `浏览器仍拒绝复制，请按 Ctrl+C：${error.message}`;
    }
  });

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '关闭';
  closeButton.addEventListener('click', () => overlay.remove());

  actions.append(copyButton, closeButton);
  panel.append(title, input, feedback, actions);
  overlay.append(panel);
  document.body.append(overlay);

  input.focus();
  input.select();
}

function showTotpSecretCopyFallback(totpSecret, email) {
  const existing = document.getElementById('totpSecretCopyFallback');
  existing?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'totpSecretCopyFallback';
  overlay.className = 'copy-fallback-overlay';

  const panel = document.createElement('section');
  panel.className = 'copy-fallback-panel';

  const title = document.createElement('h3');
  title.textContent = `2FA 密钥：${email}`;

  const input = document.createElement('textarea');
  input.className = 'copy-fallback-value';
  input.value = totpSecret;
  input.readOnly = true;
  input.rows = 2;
  input.setAttribute('aria-label', 'TOTP secret');

  const feedback = document.createElement('p');
  feedback.className = 'copy-fallback-feedback';
  feedback.textContent = '自动复制被浏览器拦截，请点击复制或按 Ctrl+C。';

  const actions = document.createElement('div');
  actions.className = 'button-row';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = '复制 2FA';
  copyButton.addEventListener('click', async () => {
    input.focus();
    input.select();
    try {
      await copyTextToClipboard(totpSecret);
      feedback.textContent = '已复制 2FA 密钥。';
    } catch (error) {
      feedback.textContent = `浏览器仍拒绝复制，请按 Ctrl+C：${error.message}`;
    }
  });
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '关闭';
  closeButton.addEventListener('click', () => overlay.remove());
  actions.append(copyButton, closeButton);
  panel.append(title, input, feedback, actions);
  overlay.append(panel);
  document.body.append(overlay);
  input.focus();
  input.select();
}

function showCredentialExportCopyFallback(exportText, email) {
  const existing = document.getElementById('credentialExportCopyFallback');
  existing?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'credentialExportCopyFallback';
  overlay.className = 'copy-fallback-overlay';

  const panel = document.createElement('section');
  panel.className = 'copy-fallback-panel';

  const title = document.createElement('h3');
  title.textContent = `账号资料：${email}`;

  const input = document.createElement('textarea');
  input.className = 'copy-fallback-value';
  input.value = exportText;
  input.readOnly = true;
  input.rows = 3;
  input.setAttribute('aria-label', 'Account credentials');

  const feedback = document.createElement('p');
  feedback.className = 'copy-fallback-feedback';
  feedback.textContent = '自动复制被浏览器拦截，请点击复制或按 Ctrl+C。';

  const actions = document.createElement('div');
  actions.className = 'button-row';
  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.textContent = '复制账号';
  copyButton.addEventListener('click', async () => {
    input.focus();
    input.select();
    try {
      await copyTextToClipboard(exportText);
      feedback.textContent = '已复制账号资料。';
    } catch (error) {
      feedback.textContent = `浏览器仍拒绝复制，请按 Ctrl+C：${error.message}`;
    }
  });
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '关闭';
  closeButton.addEventListener('click', () => overlay.remove());
  actions.append(copyButton, closeButton);
  panel.append(title, input, feedback, actions);
  overlay.append(panel);
  document.body.append(overlay);
  input.focus();
  input.select();
}

function renderVisibleTab() {
  renderView(state.activeTab);
}

function hasCapability(name) {
  return state.config?.capabilities?.[name] !== false;
}

function viewEnabled(tab) {
  const capability = { run: 'registration', mail: 'mailbox', proxies: 'proxies', payment: 'payment', refining: 'refining', 'phone-bind': 'phoneBind' }[tab];
  return Boolean(capability) && hasCapability(capability);
}

function workflowStageEnabled(stage) {
  const capability = { payment_method: 'paymentMethodProbe', refining: 'refining', unpaid: 'payment', paid: 'payment' }[stage];
  return !capability || hasCapability(capability);
}

function visibleWorkflowStage(stage) {
  return workflowStageEnabled(stage) ? stage : 'completed';
}

function assertApiCapability(path) {
  const pathname = String(path).split('?')[0];
  let capability;
  if (/^\/api\/refining(?:\/|$)/.test(pathname) || /^\/api\/accounts\/[^/]+\/gcash(?:\/|$)/.test(pathname)) capability = 'refining';
  else if (/^\/api\/payment-method-probe(?:\/|$)/.test(pathname) || /\/payment-methods\/probe$/.test(pathname)) capability = 'paymentMethodProbe';
  else if (/^\/api\/payment(?:\/|$)/.test(pathname) || /^\/api\/accounts\/[^/]+\/payment(?:\/|$)/.test(pathname)) capability = 'payment';
  else if (/^\/api\/accounts\/[^/]+\/phone-bind(?:\/|$)/.test(pathname)) capability = 'phoneBind';
  if (capability && !hasCapability(capability)) throw new Error(`当前工作台未启用 ${capability}`);
}

function applyCapabilities() {
  for (const node of document.querySelectorAll('[data-tab], [data-view]')) {
    node.hidden = !viewEnabled(node.dataset.tab || node.dataset.view);
  }
  for (const node of document.querySelectorAll('[data-mail-workflow-stage]')) {
    node.hidden = !workflowStageEnabled(node.dataset.mailWorkflowStage);
  }
  for (const node of document.querySelectorAll('[data-pipeline-stage]')) {
    const capability = { paymentMethod: 'paymentMethodProbe', refining: 'refining', finalPayment: 'payment', phoneBind: 'phoneBind' }[node.dataset.pipelineStage];
    node.hidden = Boolean(capability && !hasCapability(capability));
  }
  const configuredPools = state.config?.proxyPools;
  for (const node of document.querySelectorAll('[data-pool]')) {
    const available = Array.isArray(configuredPools)
      ? configuredPools.includes(node.dataset.pool)
      : hasCapability('payment') || hasCapability('refining') || ['main', 'eligibility'].includes(node.dataset.pool);
    node.hidden = !hasCapability('proxies') || !available;
  }
  if (!workflowStageEnabled(state.activeMailWorkflowStage)) {
    state.activeMailWorkflowStage = 'preparing';
    localStorage.setItem('activeMailWorkflowStage', 'preparing');
  }
  if (!viewEnabled(state.activeTab)) state.activeTab = 'run';
  for (const node of document.querySelectorAll('[data-tab], [data-view]')) {
    node.classList.toggle('active', (node.dataset.tab || node.dataset.view) === state.activeTab);
  }
  if (!hasCapability('phoneBind') && hasCapability('registration')) {
    const settings = document.querySelector('[data-view="phone-bind"] > .panel');
    const destination = document.querySelector('.run-extra-settings .advanced-section-body');
    if (settings && destination) {
      destination.append(settings);
      settings.querySelector('h2').textContent = '注册后接码入口验证配置';
      $('phoneBindAutoEnabled').closest('label').hidden = true;
    }
  }
}

function setTab(tab) {
  tab = viewEnabled(tab) ? tab : 'run';
  state.activeTab = tab;
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  for (const view of document.querySelectorAll('[data-view]')) {
    view.classList.toggle('active', view.dataset.view === tab);
  }
  renderVisibleTab();
}

function item({ title, meta, clickable = false, status = '' }) {
  const node = document.createElement('div');
  node.className = `item${clickable ? ' clickable' : ''}`;
  if (status) node.dataset.status = status;
  const strong = document.createElement('strong');
  strong.textContent = title;
  const code = document.createElement('code');
  code.textContent = meta || '';
  node.append(strong, code);
  return node;
}

function normalizeDomain(value = '') {
  return String(value || '').trim().replace(/^@+/, '').replace(/^\*\./, '').toLowerCase();
}

function isMailComSplitDomainAllowed(value = '') {
  const domain = normalizeDomain(value);
  return Boolean(domain);
}

function mailComSharedDomains() {
  const config = state.config?.mailbox?.mailComSplit || {};
  const byDomain = new Map();
  const remember = (value, domainState = 'CONFIGURED') => {
    const domain = normalizeDomain(typeof value === 'string' ? value : value?.domain);
    if (!isMailComSplitDomainAllowed(domain)) return;
    const nextState = String(typeof value === 'string' ? domainState : value?.state || domainState).toUpperCase();
    const previous = byDomain.get(domain);
    const next = {
      domain,
      state: nextState,
      blacklisted: Boolean(typeof value === 'object' && value?.blacklisted),
      noCodeBlacklisted: Boolean(typeof value === 'object' && (value?.noCodeBlacklisted ?? value?.blacklisted)),
      noTrialBlacklisted: Boolean(typeof value === 'object' && value?.noTrialBlacklisted),
      consecutiveOtpTimeoutTasks: Number(typeof value === 'object' && value?.consecutiveOtpTimeoutTasks || 0),
      consecutiveNoTrialTasks: Number(typeof value === 'object' && value?.consecutiveNoTrialTasks || 0),
      failureUpdatedAt: typeof value === 'object' ? value?.failureUpdatedAt || null : null,
    };
    if (!previous) {
      byDomain.set(domain, next);
      return;
    }
    byDomain.set(domain, {
      ...previous,
      ...next,
      state: previous.state === 'ACTIVE' || nextState === 'ACTIVE' ? 'ACTIVE' : previous.state,
      blacklisted: previous.blacklisted || next.blacklisted,
      noCodeBlacklisted: previous.noCodeBlacklisted || next.noCodeBlacklisted,
      noTrialBlacklisted: previous.noTrialBlacklisted || next.noTrialBlacklisted,
      consecutiveOtpTimeoutTasks: Math.max(previous.consecutiveOtpTimeoutTasks, next.consecutiveOtpTimeoutTasks),
      consecutiveNoTrialTasks: Math.max(previous.consecutiveNoTrialTasks, next.consecutiveNoTrialTasks),
    });
  };
  for (const entry of config.sharedAvailableDomains || []) remember(entry);
  for (const domain of config.domains || []) remember(domain);
  for (const account of state.mailComAccounts || []) {
    for (const entry of account.availableDomains || []) remember(entry);
  }
  return [...byDomain.values()].sort((left, right) => {
    const activeOrder = Number(right.state === 'ACTIVE') - Number(left.state === 'ACTIVE');
    return activeOrder || left.domain.localeCompare(right.domain);
  });
}

function ensureMailComDomainOptions() {
  const id = 'mailComSharedDomainOptions';
  let list = document.getElementById(id);
  if (!list) {
    list = document.createElement('datalist');
    list.id = id;
    document.body.append(list);
  }
  list.replaceChildren(...mailComSharedDomains().filter((entry) => !entry.noCodeBlacklisted && !entry.noTrialBlacklisted).map((entry) => {
    const option = document.createElement('option');
    option.value = entry.domain;
    option.label = entry.state === 'ACTIVE' ? `${entry.domain}（显示）` : entry.domain;
    return option;
  }));
  return id;
}

function mailComDomainAllowedForAccount(account, domain) {
  const normalized = normalizeDomain(domain);
  if (!isMailComSplitDomainAllowed(normalized)) return false;
  const accountDomains = Array.isArray(account?.availableDomains) ? account.availableDomains : [];
  if (!accountDomains.length) return true;
  return accountDomains.some((entry) => normalizeDomain(entry?.domain) === normalized
    && !entry?.blacklisted && !entry?.noCodeBlacklisted && !entry?.noTrialBlacklisted);
}

function emailDomain(email = '') {
  const text = String(email || '').trim().toLowerCase();
  const at = text.lastIndexOf('@');
  return at >= 0 ? text.slice(at + 1) : '';
}

function cfDomainMatches(email) {
  const domain = emailDomain(email);
  const domains = state.cfMailbox?.domains || state.config?.mailbox?.cloudflareTempEmail?.domains || [];
  return Boolean(domain && domains.map(normalizeDomain).some((configured) => configured && (domain === configured || domain.endsWith(`.${configured}`))));
}

function mailComAccountForEmail(email = '') {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  return state.mailComAccounts.find((account) => {
    if (String(account.email || '').trim().toLowerCase() === target) return true;
    return Array.isArray(account.aliases) && account.aliases.some((alias) => String(alias || '').trim().toLowerCase() === target);
  }) || null;
}

function mailboxMeta(entry) {
  if (entry.mailboxUrl) return entry.mailboxUrl;
  const mailComAccount = mailComAccountForEmail(entry.email);
  if (entry.mailboxSource === 'mail_com_split' || mailComAccount) {
    return mailComAccount
      ? `mail.com split · ${mailComAccount.email}`
      : 'mail.com split';
  }
  if (entry.mailboxSource === 'cloudflare_temp_email_generated' || cfDomainMatches(entry.email)) return `Cloudflare Worker · ${emailDomain(entry.email)}`;
  if (entry.mailboxSource === 'icmail_public') return 'IC Mail API';
  return '无取件来源';
}

function latestEvent(task, predicate = () => true) {
  return [...(task?.events || [])].reverse().find(predicate) || null;
}


function sanitizeStatusText(value = '') {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/authorization:\s*Bearer\s+[^·]+/giu, 'authorization: Bearer [hidden]')
    .replace(/cookie:\s*[^·]+/giu, 'cookie: [hidden]')
    .replace(/set-cookie:\s*[^·]+/giu, 'set-cookie: [hidden]')
    .trim();
}

function shortStatusText(value = '', maxLength = 180) {
  const text = sanitizeStatusText(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function taskSummary(task, registrationView = null) {
  if (registrationView?.jobId) {
    return {
      status: registrationView.status || 'unknown',
      step: registrationView.step || '',
      taskId: registrationView.jobId || '',
      detail: shortStatusText(registrationView.detail || registrationView.label || ''),
      fullDetail: sanitizeStatusText(registrationView.detail || registrationView.label || ''),
      otpCode: '',
      lastEventType: '',
      hasTask: true,
      registrationView,
    };
  }
  if (!task) {
    return {
      status: '未启动',
      step: 'ready',
      taskId: '',
      detail: '',
      otpCode: '',
      hasTask: false,
    };
  }
  const otpEvent = latestEvent(task, (event) => event.otpCode);
  const errorEvent = latestEvent(task, (event) => event.error);
  const lastEvent = latestEvent(task);
  const lastMessage = typeof lastEvent?.message === 'string' ? lastEvent.message.trim() : '';
  const detail = errorEvent?.error
    ? `${errorEvent.error.code}: ${errorEvent.error.message}`
    : (lastMessage || lastEvent?.type || '');
  const safeDetail = sanitizeStatusText(detail);
  return {
    status: task.status || 'unknown',
    step: task.currentStep || '',
    taskId: task.id || '',
    detail: shortStatusText(safeDetail),
    fullDetail: safeDetail,
    otpCode: otpEvent?.otpCode || '',
    lastEventType: lastEvent?.type || '',
    hasTask: true,
  };
}

function taskById() {
  const map = new Map();
  for (const task of state.tasks) {
    if (task?.id) map.set(task.id, task);
  }
  return map;
}

async function loadTaskDetails(taskId) {
  const detail = await api.get(`/api/tasks/${encodeURIComponent(taskId)}`);
  const index = state.tasks.findIndex((task) => task.id === taskId);
  if (index >= 0) state.tasks[index] = { ...detail, eventsTruncated: false };
  renderEmailRunStatus();
}

function accountById() {
  const map = new Map();
  for (const account of state.accounts) {
    if (account?.id) map.set(account.id, account);
  }
  return map;
}

function accountByEmail() {
  const map = new Map();
  for (const account of state.accounts) {
    const email = String(account.email || '').toLowerCase();
    if (email) map.set(email, account);
  }
  return map;
}

function isImportedTask(task) {
  const importedEmails = new Set(state.emails.map((entry) => String(entry.email || '').toLowerCase()));
  return importedEmails.has(String(task?.email || '').toLowerCase()) || task?.mailboxSource === 'cloudflare_temp_email_generated';
}

function isDomainEmailEntry(entry) {
  return entry?.mailboxSource === 'cloudflare_temp_email_generated' || cfDomainMatches(entry?.email);
}

function isMailComEmailEntry(entry) {
  return entry?.mailboxSource === 'mail_com_split';
}

function runEmailCategory(entry) {
  if (isDomainEmailEntry(entry)) return 'domain';
  if (isMailComEmailEntry(entry)) return 'mail_com';
  return 'ic';
}

function mailInventoryEntries() {
  if (state.activeMailCategory === 'domain') return state.emails.filter(isDomainEmailEntry);
  if (state.activeMailCategory === 'mail_com') return state.emails.filter(isMailComEmailEntry);
  return state.emails.filter((entry) => runEmailCategory(entry) === 'ic');
}

function setMailCategory(category) {
  state.activeMailCategory = ['ic', 'domain', 'mail_com'].includes(category) ? category : 'ic';
  localStorage.setItem('activeMailCategory', state.activeMailCategory);
  if (state.activeMailCategory === 'mail_com') {
    state.activeRunCategory = 'mail_com';
    localStorage.setItem('activeRunCategory', state.activeRunCategory);
  }
  state.selectedEmailIds.clear();
  renderEmailInventory();
  renderEmailRunStatus();
}

function setRunCategory(category) {
  state.activeRunCategory = ['ic', 'domain', 'mail_com'].includes(category) ? category : 'ic';
  localStorage.setItem('activeRunCategory', state.activeRunCategory);
  renderEmailRunStatus();
}

function openMailComAliasManager() {
  state.activeMailCategory = 'mail_com';
  state.activeRunCategory = 'mail_com';
  state.mailComManagerOpen = true;
  state.mailComStartedManagerOpen = true;
  localStorage.setItem('activeMailCategory', 'mail_com');
  localStorage.setItem('activeRunCategory', 'mail_com');
  localStorage.setItem('mailComManagerOpen', 'true');
  localStorage.setItem('mailComStartedManagerOpen', 'true');
  setTab('run');
  renderEmailInventory();
  renderMailComSplitAccounts();
  requestAnimationFrame(() => {
    const target = document.getElementById('mailComManagementTitle') || document.getElementById('mailComMainAccounts');
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  });
}

function setMailWorkflowStage(stage) {
  const normalized = workflowStageEnabled(stage) ? stage : 'preparing';
  state.activeMailWorkflowStage = MAIL_WORKFLOW_STAGES.includes(normalized)
    ? normalized
    : 'preparing';
  localStorage.setItem('activeMailWorkflowStage', state.activeMailWorkflowStage);
  state.selectedWorkflowEmails.clear();
  renderEmailRunStatus();
}

async function startTaskForEmail(entry) {
  if (!entry?.email) return;
  const key = String(entry.email || '').toLowerCase();
  if (state.activeTaskStarts.has(key)) return;
  state.activeTaskStarts.add(key);
  $('startFeedback').textContent = `正在创建注册任务：${entry.email}`;
  renderEmailRunStatus();
  try {
    const payload = {
      email: entry.email,
      mailboxUrl: entry.mailboxUrl || undefined,
      proxyPoolId: proxyPoolPayload('main'),
      ...registrationExecutionPayload(),
    };
    const result = await api.post(isMailComEmailEntry(entry) ? '/api/tasks/mail-com-split' : '/api/tasks', payload);
    const task = result.task || result;
    state.expandedTaskIds.add(task.id);
    $('startFeedback').textContent = `任务已创建：${task.id}`;
    await refresh({ silent: true });
    setTab('run');
  } catch (error) {
    $('startFeedback').textContent = `启动失败：${error.message}`;
    renderEmailRunStatus();
  } finally {
    state.activeTaskStarts.delete(key);
  }
}

async function startCloudflareGeneratedTask() {
  $('startFeedback').textContent = '正在生成 Cloudflare 邮箱并启动…';
  try {
    const result = await api.post('/api/tasks/cloudflare-temp-email', {
      usernamePrefix: $('cfRunUsernamePrefix').value,
      proxyPoolId: proxyPoolPayload('main'),
      ...registrationExecutionPayload(),
    });
    state.expandedTaskIds.add(result.task.id);
    $('startFeedback').textContent = `任务已创建：${result.task.id} · ${result.email}`;
    await refresh({ silent: true });
    setTab('run');
  } catch (error) {
    $('startFeedback').textContent = `生成启动失败：${error.message}`;
  }
}

function protocolEligibilityReady(account) {
  return account?.passwordStatus === 'has_password'
    && account?.totpStatus === 'enabled'
    && account?.accessTokenAvailable === true;
}

async function checkEligibilityForEmail(entry) {
  if (!entry?.email) return;
  $('startFeedback').textContent = `正在检测试用资格：${entry.email}`;
  try {
    const result = await api.post(`/api/accounts/${encodeURIComponent(entry.email)}/eligibility`, {
      proxyPoolId: proxyPoolPayload('main'),
    });
    await refresh({ silent: true });
    if (result.status === 'failed') {
      $('startFeedback').textContent = `资格检测失败：${entry.email} · ${result.error?.code || 'unknown'} · ${result.error?.message || ''}`;
      return;
    }
    $('startFeedback').textContent = `资格检测完成：${entry.email} · ${eligibilityText(result.account)}`;
  } catch (error) {
    $('startFeedback').textContent = `资格检测请求失败：${error.message}`;
  }
}

async function checkAccountStatusForEmail(entry) {
  if (!entry?.email) return;
  const key = normalizeEmailKey(entry.email);
  if (state.activeAccountStatusChecks.has(key)) return;
  state.activeAccountStatusChecks.add(key);
  setMailRunAccountFeedback(entry.email, '账号状态检测中…', { ttlMs: 60000 });
  renderEmailRunStatus();
  $('startFeedback').textContent = `正在检测账号状态：${entry.email}`;
  try {
    const result = await api.post(`/api/accounts/${encodeURIComponent(entry.email)}/account-status`, {
      proxyPoolId: proxyPoolPayload('main'),
    });
    await refresh({ silent: true });
    const detectedPlan = result.result?.accountPlan
      ? { accountPlan: result.result.accountPlan }
      : result.account;
    if (result.status === 'failed') {
      const preservedPlan = result.account?.accountPlan ? ` · 保留：${accountPlanBriefText(result.account)}` : '';
      const message = `账号状态检测失败：${result.error?.code || 'unknown'} · ${result.error?.message || ''}${preservedPlan}`;
      setMailRunAccountFeedback(entry.email, message);
      $('startFeedback').textContent = `账号状态检测失败：${entry.email} · ${result.error?.code || 'unknown'} · ${result.error?.message || ''}${preservedPlan}`;
      return;
    }
    const message = `账号状态检测完成：${accountPlanBriefText(detectedPlan)}`;
    setMailRunAccountFeedback(entry.email, message, { ttlMs: 30000 });
    $('startFeedback').textContent = `账号状态检测完成：${entry.email} · ${accountPlanBriefText(detectedPlan)}`;
  } catch (error) {
    setMailRunAccountFeedback(entry.email, `账号状态检测请求失败：${error.message}`);
    $('startFeedback').textContent = `账号状态检测请求失败：${error.message}`;
  } finally {
    state.activeAccountStatusChecks.delete(key);
    renderEmailRunStatus();
  }
}

async function copyAccessTokenForEmail(entry) {
  if (!entry?.email) return;
  $('startFeedback').textContent = `正在读取 AT：${entry.email}`;
  try {
    const accessToken = await getSavedAccessToken(entry.email);
    if (!accessToken) {
      $('startFeedback').textContent = `该账号暂无已保存 AT：${entry.email}`;
      await refresh({ silent: true });
      return;
    }
    try {
      await copyTextToClipboard(accessToken);
      $('startFeedback').textContent = `已复制 AT：${entry.email}`;
    } catch {
      showAccessTokenCopyFallback(accessToken, entry.email);
      $('startFeedback').textContent = `AT 已读取，但自动复制被浏览器拦截：${entry.email}`;
    }
  } catch (error) {
    $('startFeedback').textContent = `读取 AT 失败：${error.message}`;
  }
}

async function copyRefreshTokenForEmail(entry) {
  if (!entry?.email) return;
  $('startFeedback').textContent = `正在读取 RT：${entry.email}`;
  try {
    const refreshToken = await getSavedRefreshToken(entry.email);
    if (!refreshToken) {
      $('startFeedback').textContent = `该账号暂无已保存 RT：${entry.email}`;
      await refresh({ silent: true });
      return;
    }
    try {
      await copyTextToClipboard(refreshToken);
      $('startFeedback').textContent = `已复制 RT：${entry.email}`;
    } catch {
      showAccessTokenCopyFallback(refreshToken, entry.email, 'RT', 'Refresh Token');
      $('startFeedback').textContent = `RT 已读取，但自动复制被浏览器拦截：${entry.email}`;
    }
  } catch (error) {
    $('startFeedback').textContent = `读取 RT 失败：${error.message}`;
  }
}

async function renewSessionCookieForEmail(entry) {
  if (!entry?.email) return;
  const key = String(entry.email || '').trim().toLowerCase();
  if (state.activeSessionCookieRenewals.has(key)) return;
  state.activeSessionCookieRenewals.add(key);
  renderEmailRunStatus();
  $('startFeedback').textContent = `正在续期 Cookie：${entry.email}`;
  try {
    const result = await api.post(`/api/accounts/${encodeURIComponent(entry.email)}/session-cookie/renew`, {});
    if (result.status === 'running') {
      $('startFeedback').textContent = `Cookie 续期已在进行：${entry.email}`;
      return;
    }
    if (result.status !== 'completed') {
      throw new Error('服务端未能验证 Cookie，原 Cookie 已保留');
    }
    await refresh({ silent: true });
    const expiresAt = result.renewal.expiresAt
      ? new Date(result.renewal.expiresAt).toLocaleString()
      : '未知时间';
    $('startFeedback').textContent = result.renewal.cookieChanged
      ? `Cookie 已续期并覆盖原记录：${entry.email} · 到期 ${expiresAt}`
      : `Cookie 仍然有效，AT 已同步：${entry.email} · 到期 ${expiresAt}`;
  } catch (error) {
    $('startFeedback').textContent = `Cookie 续期失败，原 Cookie 已保留：${entry.email} · ${error.message}`;
  } finally {
    state.activeSessionCookieRenewals.delete(key);
    renderEmailRunStatus();
  }
}

async function refreshRefreshTokenForEmail(entry) {
  if (!entry?.email) return;
  const key = String(entry.email || '').trim().toLowerCase();
  if (state.activeRefreshTokenStarts.has(key)) return;
  state.activeRefreshTokenStarts.add(key);
  renderEmailRunStatus();
  $('startFeedback').textContent = `正在轮换 RT：${entry.email}`;
  try {
    const result = await api.post(`/api/accounts/${encodeURIComponent(entry.email)}/refresh-token/refresh`, {});
    if (result.status === 'running') {
      $('startFeedback').textContent = `RT 刷新已在进行：${entry.email}`;
      return;
    }
    if (result.status !== 'completed') {
      throw new Error('RT 轮换未返回新的 RT，原记录已保留');
    }
    await refresh({ silent: true });
    $('startFeedback').textContent = `RT 已刷新：${entry.email}`;
  } catch (error) {
    $('startFeedback').textContent = `刷新 RT 失败，原 RT 已保留：${entry.email} · ${error.message}`;
  } finally {
    state.activeRefreshTokenStarts.delete(key);
    renderEmailRunStatus();
  }
}

async function refreshAccessTokenForEmail(entry) {
  if (!entry?.email) return;
  $('startFeedback').textContent = `正在刷新 AT：${entry.email}`;
  try {
    const result = await api.post(`/api/accounts/${encodeURIComponent(entry.email)}/access-token/refresh`, {});
    if (result.status === 'running') {
      $('startFeedback').textContent = `AT 刷新已在进行：${entry.email}`;
      return;
    }
    const accessToken = result?.result?.accessToken;
    if (result.status === 'failed' || !accessToken) {
      $('startFeedback').textContent = `刷新 AT 失败：${entry.email} · ${result.error?.code || 'unknown'} · ${result.error?.message || ''}`;
      await refresh({ silent: true });
      return;
    }
    await refresh({ silent: true });
    $('startFeedback').textContent = `AT 已刷新：${entry.email}`;
  } catch (error) {
    $('startFeedback').textContent = `刷新 AT 请求失败：${error.message}`;
  }
}

function selectedWorkflowRows() {
  const selected = state.selectedWorkflowEmails || new Set();
  return (state.visibleMailWorkflowRows || []).filter((row) => {
    const key = normalizeEmailKey(row?.entry?.email);
    return key && selected.has(key);
  });
}

function updateSelectedWorkflowAtLiveButton() {
  const liveCheckButton = $('checkSelectedWorkflowAtLive');
  if (!liveCheckButton) return;
  const selectedLiveRows = selectedWorkflowRows().filter((row) => row.account?.accessTokenAvailable);
  liveCheckButton.hidden = !['eligibility', 'payment_method', 'refining', 'unpaid'].includes(state.activeMailWorkflowStage);
  liveCheckButton.disabled = state.bulkCheckingAccessTokens || selectedLiveRows.length === 0;
  liveCheckButton.textContent = state.bulkCheckingAccessTokens
    ? 'AT 测活中'
    : `测活选中 AT${selectedLiveRows.length ? ` ${selectedLiveRows.length}` : ''}`;
}

function updateWorkflowStageActionButton() {
  const button = $('runWorkflowStageAction');
  if (!button) return;
  const rows = state.activeMailWorkflowRows || [];
  const repairRows = rows.filter((row) => registrationViewAction(row.registrationView).enabled);
  const stage = state.activeMailWorkflowStage;
  const eligibilityRows = rows.filter((row) => protocolEligibilityReady(row.account));
  const count = stage === 'repair' ? repairRows.length : stage === 'discarded' ? eligibilityRows.length : rows.length;
  button.hidden = !['repair', 'repair_verification', 'discarded'].includes(stage);
  button.disabled = state.bulkWorkflowActionRunning || count === 0;
  button.textContent = state.bulkWorkflowActionRunning
    ? (stage === 'repair' ? '批量排队中' : stage === 'discarded' ? '资格二检中' : '批量复检中')
    : stage === 'repair'
      ? '一键修复当前分类 ' + count
      : stage === 'discarded'
        ? '一键二检当前分类 ' + count
        : '立即复检当前分类 ' + count;
}

async function runLimited(items, limit, worker) {
  let index = 0;
  const run = async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

async function runCurrentWorkflowStageAction() {
  if (state.bulkWorkflowActionRunning) return;
  const stage = state.activeMailWorkflowStage;
  const rows = [...(state.activeMailWorkflowRows || [])];
  if (!['repair', 'repair_verification', 'discarded'].includes(stage) || !rows.length) return;
  state.bulkWorkflowActionRunning = true;
  renderEmailRunStatus();
  try {
    if (stage === 'discarded') {
      const runnable = rows.filter((row) => protocolEligibilityReady(row.account));
      let completed = 0;
      let eligible = 0;
      let failed = 0;
      await runLimited(runnable, 3, async (row) => {
        try {
          const result = await api.post('/api/accounts/' + encodeURIComponent(row.entry.email) + '/eligibility', {
            proxyPoolId: proxyPoolPayload('main'),
          });
          if (result.status === 'failed') failed += 1;
          else {
            completed += 1;
            if (result.account?.eligibilityStatus === 'eligible') eligible += 1;
          }
        } catch {
          failed += 1;
        }
      });
      $('startFeedback').textContent = '资格二检完成：检测 ' + completed + '，转为有资格 ' + eligible + '，失败 ' + failed + '，资产不足跳过 ' + (rows.length - runnable.length) + '。';
    } else if (stage === 'repair_verification') {
      const result = await api.post('/api/mailbox-repairability/recheck', {
        emails: rows.map((row) => row.entry.email),
      });
      $('startFeedback').textContent = '复检完成：有效 ' + (result.available || 0) + '，失效 ' + (result.expired || 0) + '，暂时不可达 ' + (result.unreachable || 0) + '。';
    } else {
      const runnable = rows.filter((row) => registrationViewAction(row.registrationView).enabled);
      let queued = 0;
      let skipped = rows.length - runnable.length;
      let failed = 0;
      await runLimited(runnable, 6, async (row) => {
        try {
          const view = row.registrationView;
          if (registrationAssetStatus(row.entry, row.account, view)) {
            await api.post('/api/accounts/' + encodeURIComponent(row.entry.email) + '/credential-repair', {
              proxyPoolId: proxyPoolPayload('main'),
            });
          } else if (view?.jobId && registrationViewAction(view).label === '重试') {
            await api.post('/api/tasks/' + encodeURIComponent(view.jobId) + '/retry', {
              proxyPoolId: proxyPoolPayload('main'),
              ...registrationExecutionPayload(),
            });
          } else {
            await api.post('/api/tasks', {
              email: row.entry.email,
              mailboxUrl: row.entry.mailboxUrl || undefined,
              proxyPoolId: proxyPoolPayload('main'),
              ...registrationExecutionPayload(),
            });
          }
          queued += 1;
        } catch (error) {
          if (/already|已有|not_queued|not retryable|处理中/iu.test(String(error?.message || error))) skipped += 1;
          else failed += 1;
        }
      });
      $('startFeedback').textContent = '批量修复已提交：排队 ' + queued + '，跳过 ' + skipped + '，失败 ' + failed + '。';
    }
    state.selectedWorkflowEmails.clear();
    await refresh({ silent: true });
  } catch (error) {
    $('startFeedback').textContent = '批量操作失败：' + error.message;
  } finally {
    state.bulkWorkflowActionRunning = false;
    renderEmailRunStatus();
  }
}

function selectedAtCount(category) {
  return selectedWorkflowRows().filter((row) => (
    row.account?.accessTokenAvailable && (!category || runEmailCategory(row.entry) === category)
  )).length;
}

function selectedCredentialCount(category) {
  return selectedWorkflowRows().filter((row) => (
    !credentialExportUnavailableReason(row.account) && (!category || runEmailCategory(row.entry) === category)
  )).length;
}

function updateCopySelectedAtButton(buttonId, category) {
  const button = $(buttonId);
  if (!button) return;
  const wantsAccount = ACCOUNT_COPY_MAIL_STAGES.has(state.activeMailWorkflowStage);
  const count = wantsAccount ? selectedCredentialCount(category) : selectedAtCount(category);
  button.hidden = !(AT_COPY_MAIL_STAGES.has(state.activeMailWorkflowStage) || wantsAccount);
  button.disabled = count === 0;
  const label = wantsAccount ? '复制选中账号' : '复制选中 AT';
  button.textContent = count ? `${label} ${count}` : label;
}

function updateCopySelectedAtButtons() {
  updateCopySelectedAtButton('copySelectedIcAt', 'ic');
  updateCopySelectedAtButton('copySelectedDomainAt', 'domain');
  updateCopySelectedAtButton('copySelectedMailAt', 'mail_com');
}

async function copySelectedAccessTokens(category) {
  if (ACCOUNT_COPY_MAIL_STAGES.has(state.activeMailWorkflowStage)) {
    await copySelectedCredentials(category);
    return;
  }
  const eligibleEmails = selectedWorkflowRows()
    .filter((row) => row.account?.accessTokenAvailable && (!category || runEmailCategory(row.entry) === category))
    .map((row) => row.entry.email);
  if (!eligibleEmails.length) {
    $('startFeedback').textContent = '没有选中可复制 AT 的账号。';
    updateCopySelectedAtButtons();
    return;
  }
  $('startFeedback').textContent = `正在读取 ${eligibleEmails.length} 个 AT…`;
  const tokens = [];
  const failures = [];
  for (const email of eligibleEmails) {
    try {
      const accessToken = await getSavedAccessToken(email);
      if (accessToken) tokens.push(accessToken);
      else failures.push(email);
    } catch {
      failures.push(email);
    }
  }
  if (!tokens.length) {
    $('startFeedback').textContent = '选中账号没有可复制的已保存 AT。';
    return;
  }
  const text = tokens.join('\n');
  try {
    await copyTextToClipboard(text);
    $('startFeedback').textContent = `已复制 ${tokens.length} 个 AT${failures.length ? `，跳过 ${failures.length} 个` : ''}`;
  } catch {
    showAccessTokenCopyFallback(text, `${tokens.length} 个账号`);
    $('startFeedback').textContent = `已读取 ${tokens.length} 个 AT，但自动复制被浏览器拦截${failures.length ? `，跳过 ${failures.length} 个` : ''}`;
  }
}

async function copySelectedCredentials(category) {
  if (state.bulkCopyingCredentials) return;
  const rows = selectedWorkflowRows()
    .filter((row) => !credentialExportUnavailableReason(row.account) && (!category || runEmailCategory(row.entry) === category));
  if (!rows.length) {
    $('startFeedback').textContent = '没有选中可复制账号资料的账号。';
    updateCopySelectedAtButtons();
    return;
  }
  $('startFeedback').textContent = `正在读取 ${rows.length} 个账号资料…`;
  state.bulkCopyingCredentials = true;
  try {
    renderEmailRunStatus();
    const values = [];
    const failures = [];
    for (const row of rows) {
      try {
        const result = await api.get(`/api/accounts/${encodeURIComponent(row.entry.email)}/credential-export`);
        if (result.exportText) values.push(result.exportText);
        else failures.push(row.entry.email);
      } catch {
        failures.push(row.entry.email);
      }
    }
    if (!values.length) {
      $('startFeedback').textContent = '选中账号没有可复制的账号资料。';
      return;
    }
    const text = values.join('\n');
    try {
      await copyTextToClipboard(text);
      $('startFeedback').textContent = `已复制 ${values.length} 个账号资料${failures.length ? `，跳过 ${failures.length} 个` : ''}`;
    } catch {
      showCredentialExportCopyFallback(text, `${values.length} 个账号`);
      $('startFeedback').textContent = `已读取 ${values.length} 个账号资料，但自动复制被浏览器拦截${failures.length ? `，跳过 ${failures.length} 个` : ''}`;
    }
  } finally {
    state.bulkCopyingCredentials = false;
    renderEmailRunStatus();
  }
}

async function checkSelectedWorkflowAccessTokensLive() {
  if (state.bulkCheckingAccessTokens) return;
  const rows = selectedWorkflowRows().filter((row) => row.account?.accessTokenAvailable);
  if (!rows.length) {
    $('startFeedback').textContent = '没有选中可测活的 AT。';
    return;
  }
  state.bulkCheckingAccessTokens = true;
  renderEmailRunStatus();
  let invalid = 0;
  let failed = 0;
  try {
    for (const row of rows) {
      try {
        const result = await api.post(`/api/accounts/${encodeURIComponent(row.entry.email)}/access-token/live-check`, {});
        if (result.removed) invalid += 1;
      } catch {
        failed += 1;
      }
    }
    await refresh({ silent: true });
    $('startFeedback').textContent = `AT 测活完成：失效删除 ${invalid} 个，失败保留 ${failed} 个。`;
  } finally {
    state.bulkCheckingAccessTokens = false;
    renderEmailRunStatus();
  }
}

async function copyTotpSecretForEmail(entry) {
  if (!entry?.email) return;
  $('startFeedback').textContent = `正在读取 2FA 密钥：${entry.email}`;
  try {
    const result = await api.get(`/api/accounts/${encodeURIComponent(entry.email)}/totp-secret`);
    try {
      await copyTextToClipboard(result.totpSecret);
      $('startFeedback').textContent = `已复制 2FA 密钥：${entry.email}`;
    } catch {
      showTotpSecretCopyFallback(result.totpSecret, entry.email);
      $('startFeedback').textContent = `2FA 密钥已读取，但自动复制被浏览器拦截：${entry.email}`;
    }
  } catch (error) {
    $('startFeedback').textContent = `读取 2FA 密钥失败：${error.message}`;
  }
}

async function fetchCredentialExport(email) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`/api/accounts/${encodeURIComponent(email)}/credential-export`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw await api.parseError(response);
    return response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('读取账号资料超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function copyCredentialExportForEmail(entry, preparedResult = null) {
  if (!entry?.email) return;
  $('startFeedback').textContent = `正在复制账号资料：${entry.email}`;
  const resultPromise = preparedResult || fetchCredentialExport(entry.email);
  let result = null;
  try {
    if (navigator.clipboard?.write && window.ClipboardItem) {
      const clipboardItem = new ClipboardItem({
        'text/plain': resultPromise.then((payload) => {
          result = payload;
          return new Blob([payload.exportText], { type: 'text/plain' });
        }),
      });
      await navigator.clipboard.write([clipboardItem]);
      $('startFeedback').textContent = `已复制账号资料：${entry.email}`;
      return;
    }
    result = await resultPromise;
    await copyTextToClipboard(result.exportText);
    $('startFeedback').textContent = `已复制账号资料：${entry.email}`;
  } catch (error) {
    try {
      result = result || await resultPromise;
    } catch (readError) {
      $('startFeedback').textContent = `读取账号资料失败：${readError.message}`;
      return;
    }
    try {
      await copyTextToClipboard(result.exportText);
      $('startFeedback').textContent = `已复制账号资料：${entry.email}`;
    } catch {
      showCredentialExportCopyFallback(result.exportText, entry.email);
      $('startFeedback').textContent = `账号资料已就绪，请在弹窗中复制：${entry.email}`;
    }
  }
}

function updateEmailDeleteButton() {
  const button = $('deleteSelectedEmails');
  if (!button) return;
  const count = state.selectedEmailIds.size;
  button.disabled = count === 0;
  button.textContent = count ? `删除已选 ${count}` : '删除已选';
}

function savePhoneBindDraft(email, patch) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return;
  state.phoneBindDrafts = {
    ...state.phoneBindDrafts,
    [key]: {
      ...(state.phoneBindDrafts[key] || {}),
      ...patch,
    },
  };
  localStorage.setItem('phoneBindDrafts', JSON.stringify(state.phoneBindDrafts));
}

async function startPhoneBindForEmail(entry, { forceAutomatic = false } = {}) {
  if (!entry?.email) return;
  const key = String(entry.email || '').toLowerCase();
  if (state.activePhoneBindStarts.has(key)) return;
  const phone = forceAutomatic ? '' : String(state.phoneBindDrafts[key]?.phone || '').trim();
  const automaticSms = Boolean(forceAutomatic || (!phone && state.phoneBindSettings?.smsApiKey));
  if (!phone && !automaticSms) {
    $('startFeedback').textContent = `请填写手机号，或先在“接码”配置 OpenAI SMSBower：${entry.email}`;
    return;
  }
  state.activePhoneBindStarts.add(key);
  renderEmailRunStatus();
  $('startFeedback').textContent = automaticSms
    ? `正在自动取 OpenAI 手机号并发送短信：${entry.email}`
    : `正在发送短信（网络超时会自动重试一次）：${entry.email}`;
  try {
    const result = await api.post(`/api/accounts/${encodeURIComponent(entry.email)}/phone-bind`, phone ? { phone } : {});
    const accountIndex = state.accounts.findIndex((account) => String(account.email || '').trim().toLowerCase() === key);
    if (accountIndex >= 0 && result.account) state.accounts[accountIndex] = result.account;
    if (result.account?.phoneNumber && !result.smsAuto) savePhoneBindDraft(entry.email, { phone: result.account.phoneNumber });
    $('startFeedback').textContent = result.status === 'completed'
      ? `手机号已绑定：${entry.email}`
      : result.phoneReplaced
        ? `已换号并发送短信：${entry.email}`
        : `短信已发送：${entry.email}`;
    renderEmailRunStatus();
    if (automaticSms && result.status === 'otp_required') {
      $('startFeedback').textContent = `正在自动等待验证码并提交（超时会自动换号）：${entry.email}`;
      await submitPhoneBindCodeForEmail(entry, { forceAutomatic: true });
    } else {
      refresh({ silent: true }).catch(() => {});
    }
  } catch (error) {
    $('startFeedback').textContent = `接码启动失败：${error.message}`;
  } finally {
    state.activePhoneBindStarts.delete(key);
    renderEmailRunStatus();
  }
}

async function submitPhoneBindCodeForEmail(entry, { forceAutomatic = false } = {}) {
  if (!entry?.email) return;
  const key = String(entry.email || '').toLowerCase();
  const code = forceAutomatic ? '' : String(state.phoneBindDrafts[key]?.code || '').trim();
  const account = state.accounts.find((item) => String(item.email || '').trim().toLowerCase() === key);
  const automaticSms = Boolean(forceAutomatic || (!code && account?.phoneBindSmsAuto));
  if (!code && !automaticSms) {
    $('startFeedback').textContent = `先填写短信验证码：${entry.email}`;
    return;
  }
  const ownsActiveState = !state.activePhoneBindStarts.has(key);
  if (ownsActiveState) state.activePhoneBindStarts.add(key);
  renderEmailRunStatus();
  $('startFeedback').textContent = automaticSms
    ? `正在从 SMSBower 自动取码并提交：${entry.email}`
    : `正在提交短信验证码：${entry.email}`;
  try {
    const result = await api.post(`/api/accounts/${encodeURIComponent(entry.email)}/phone-bind/code`, code ? { code } : {});
    savePhoneBindDraft(entry.email, { code: '' });
    const accountIndex = state.accounts.findIndex((account) => String(account.email || '').trim().toLowerCase() === key);
    if (accountIndex >= 0 && result.account) state.accounts[accountIndex] = result.account;
    if (result.status === 'completed') {
      const emailIndex = state.emails.findIndex((item) => String(item.email || '').trim().toLowerCase() === key);
      if (emailIndex >= 0) {
        state.emails[emailIndex] = {
          ...state.emails[emailIndex],
          mailComStage: result.mailComStage || 'completed',
        };
      }
      $('startFeedback').textContent = `手机号绑定完成，已移到完成：${entry.email}`;
    } else {
      $('startFeedback').textContent = `仍在等待验证码确认：${entry.email}`;
    }
    renderEmailRunStatus();
    refresh({ silent: true }).catch(() => {});
  } catch (error) {
    $('startFeedback').textContent = `验证码提交失败：${error.message}`;
  } finally {
    if (ownsActiveState) state.activePhoneBindStarts.delete(key);
    renderEmailRunStatus();
  }
}

async function setMailComStageForEmail(entry, stage) {
  if (!entry?.email) return;
  const normalized = String(stage || '').trim().toLowerCase();
  const persistedStage = normalized === 'unpaid' ? 'pending_payment' : normalized;
  const labels = { payment_method: '支付方式待定', refining: '提炼', unpaid: '未支付', pending_payment: '未支付', paid: '已支付', completed: '已完成', sold: '已售' };
  $('startFeedback').textContent = `正在移动到${labels[normalized] || normalized}：${entry.email}`;
  try {
    const result = await api.put(`/api/emails/${encodeURIComponent(entry.email)}/mail-com-stage`, { stage: persistedStage });
    const key = String(entry.email || '').trim().toLowerCase();
    const emailIndex = state.emails.findIndex((item) => String(item.email || '').trim().toLowerCase() === key);
    if (emailIndex >= 0) {
      state.emails[emailIndex] = {
        ...state.emails[emailIndex],
        ...(result.email || {}),
        mailComStage: persistedStage,
      };
    }
    renderEmailRunStatus();
    $('startFeedback').textContent = `已移动到${labels[normalized] || normalized}：${entry.email}`;
    refresh({ silent: true }).catch(() => {});
  } catch (error) {
    $('startFeedback').textContent = `移动失败：${error.message}`;
  }
}
async function startRefiningForEmail(entry) {
  if (!entry?.email) return;
  const key = normalizeEmailKey(entry.email);
  if (state.activeRefiningStarts.has(key)) return;
  state.activeRefiningStarts.add(key);
  setMailRunAccountFeedback(entry.email, '正在加入提炼…', { ttlMs: 60000 });
  renderEmailRunStatus();
  $('startFeedback').textContent = `正在加入提炼：${entry.email}`;
  try {
    const result = await api.post(`/api/refining/accounts/${encodeURIComponent(entry.email)}/retry`, {});
    await refresh({ silent: true });
    if (result.queued?.length) {
      setMailRunAccountFeedback(entry.email, '已加入提炼队列', { ttlMs: 30000 });
      $('startFeedback').textContent = `已加入提炼：${entry.email}`;
      return;
    }
    const reason = result.skipped?.[0]?.reason || 'unknown';
    setMailRunAccountFeedback(entry.email, `提炼未加入：${reason}`);
    $('startFeedback').textContent = `提炼未加入：${entry.email} · ${reason}`;
  } catch (error) {
    setMailRunAccountFeedback(entry.email, `提炼启动失败：${error.message}`);
    $('startFeedback').textContent = `提炼启动失败：${error.message}`;
  } finally {
    state.activeRefiningStarts.delete(key);
    renderEmailRunStatus();
  }
}

async function startPaymentMethodProbeForEmail(entry) {
  if (!entry?.email) return;
  const key = normalizeEmailKey(entry.email);
  if (state.activePaymentMethodProbeStarts.has(key)) return;
  state.activePaymentMethodProbeStarts.add(key);
  setMailRunAccountFeedback(entry.email, '正在重新检测支付方式…', { ttlMs: 60000 });
  renderEmailRunStatus();
  $('startFeedback').textContent = `正在重新检测支付方式：${entry.email}`;
  try {
    const result = await api.post(`/api/accounts/${encodeURIComponent(entry.email)}/payment-methods/probe`, {});
    await refresh({ silent: true });
    const reason = result.scheduled === false ? `未加入：${result.reason || 'unknown'}` : '已加入检测队列';
    setMailRunAccountFeedback(entry.email, `支付方式检测${reason}`, { ttlMs: 30000 });
    $('startFeedback').textContent = `支付方式检测${reason}：${entry.email}`;
  } catch (error) {
    setMailRunAccountFeedback(entry.email, `支付方式检测失败：${error.message}`);
    $('startFeedback').textContent = `支付方式检测失败：${error.message}`;
  } finally {
    state.activePaymentMethodProbeStarts.delete(key);
    renderEmailRunStatus();
  }
}

async function startGcashRefiningForEmail(entry) {
  if (!entry?.email) return;
  const key = normalizeEmailKey(entry.email);
  if (state.activeGcashRefiningStarts.has(key)) return;
  state.activeGcashRefiningStarts.add(key);
  setMailRunAccountFeedback(entry.email, '正在加入 GC 提炼…', { ttlMs: 60000 });
  renderEmailRunStatus();
  $('startFeedback').textContent = `正在加入 GC 提炼：${entry.email}`;
  try {
    const result = await api.post(`/api/refining/accounts/${encodeURIComponent(entry.email)}/gcash/retry`, {});
    await refresh({ silent: true });
    if (result.queued?.length) {
      setMailRunAccountFeedback(entry.email, '已加入 GC 提炼队列', { ttlMs: 30000 });
      $('startFeedback').textContent = `已加入 GC 提炼：${entry.email}`;
      return;
    }
    const reason = result.skipped?.[0]?.reason || 'unknown';
    setMailRunAccountFeedback(entry.email, `GC 提炼未加入：${reason}`);
    $('startFeedback').textContent = `GC 提炼未加入：${entry.email} · ${reason}`;
  } catch (error) {
    const message = String(error?.message || error || '').trim();
    const compact = message.startsWith('500')
      ? '服务接口 500，底部有完整错误'
      : (message.length > 80 ? `${message.slice(0, 80)}…` : message);
    setMailRunAccountFeedback(entry.email, `GC 提炼启动失败：${compact}`);
    $('startFeedback').textContent = `GC 提炼启动失败：${entry.email} · ${message || '未知错误'}`;
  } finally {
    state.activeGcashRefiningStarts.delete(key);
    renderEmailRunStatus();
  }
}
function gcashQrListenerIsLive(qr) {
  if (!qr || typeof qr !== 'object') return false;
  return qr.browserAlive === true
    && String(qr.authorizationStatus || '').toLowerCase() === 'waiting_phone_authorize';
}

function gcashQrIsExpired(qr) {
  const expiresAt = Date.parse(String(qr?.qrExpiresAt || ''));
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

const GCASH_STATE_VALUES = new Set([
  'idle',
  'extracting',
  'qr_ready',
  'qr_expired',
  'scanned',
  'confirming',
  'plus_confirmed',
  'failed',
  'closed',
]);

function gcashQrMkRef(qr = null, account = null) {
  const accountRef = gcashMkRef(account);
  const source = qr && typeof qr === 'object' ? qr : {};
  const mkJobId = String(accountRef?.mkJobId || source.mkJobId || '').trim();
  const mkAccountId = String(accountRef?.mkAccountId || source.mkAccountId || '').trim();
  return mkJobId && mkAccountId ? { mkJobId, mkAccountId } : null;
}

function gcashStateFromQr(qr, account = null) {
  if (!qr || typeof qr !== 'object') return 'idle';
  const status = String(qr.status || '').trim().toLowerCase();
  const postStatus = String(qr.gcashPostCheckoutStatus || '').trim().toLowerCase();
  const mkStatus = String(qr.mkPaymentStatus || qr.gcashStateReason || postStatus || '').trim().toLowerCase();
  if (qr.gcashConfirmedPlus === true || postStatus === 'plus_confirmed' || mkStatus === 'completed') return 'plus_confirmed';
  if (['callback_failed', 'callback_unconfirmed', 'failed'].includes(mkStatus) || status === 'error') return 'failed';
  if (['abandoned', 'monitor_ref_missing'].includes(mkStatus) || status === 'closed') return 'closed';
  const hasMkRef = Boolean(gcashQrMkRef(qr, account));
  const qrNeedsMkRef = Boolean(status || mkStatus || qr.gcashState || qr.imageBase64 || qr.qrExpiresAt)
    && !['closed', 'error'].includes(status);
  if (!hasMkRef && qrNeedsMkRef) return 'closed';
  if (mkStatus === 'expired' || status === 'expired' || gcashQrIsExpired(qr)) return 'qr_expired';
  if (mkStatus === 'callback_processing') return 'confirming';
  if (mkStatus === 'redirect_captured') return 'scanned';
  if (['waiting_scan'].includes(mkStatus) || status === 'ready') return 'qr_ready';
  if (['starting', 'refreshing'].includes(mkStatus) || ['capturing', 'refreshing'].includes(status)) return 'extracting';
  const explicit = String(qr.gcashState || '').trim().toLowerCase();
  if (explicit === 'failed' && mkStatus === 'unavailable') return 'idle';
  if (explicit === 'failed' && mkStatus === 'abandoned') return 'closed';
  if (GCASH_STATE_VALUES.has(explicit)) return explicit;
  return 'idle';
}

function gcashQrCanBeDisplayed(qr, account = null) {
  const status = String(qr?.status || '').toLowerCase();
  const state = gcashStateFromQr(qr, account);
  const hasMkRef = Boolean(gcashQrMkRef(qr, account));
  if (!hasMkRef && state !== 'plus_confirmed') return false;
  return (state === 'qr_ready' && gcashQrListenerIsLive(qr) && !gcashQrIsExpired(qr) && status !== 'refreshing')
    || ['scanned', 'confirming', 'plus_confirmed'].includes(state);
}

function showGcashQrModal(result) {
  const current = { ...(result || {}) };
  const overlay = document.createElement('div');
  overlay.className = 'copy-fallback-overlay';
  const panel = document.createElement('div');
  panel.className = 'copy-fallback-panel gcash-qr-panel';
  const title = document.createElement('h3');
  const meta = document.createElement('p');
  meta.className = 'field-hint';
  const img = document.createElement('img');
  img.className = 'gcash-qr-image';
  img.alt = 'GCash QR';
  const linkDetails = document.createElement('details');
  linkDetails.className = 'gcash-link-details';
  const linkSummary = document.createElement('summary');
  linkSummary.textContent = '付款链接';
  const url = document.createElement('code');
  url.className = 'mailbox-url gcash-qr-url';
  linkDetails.append(linkSummary, url);
  const buttons = document.createElement('div');
  buttons.className = 'copy-fallback-actions';
  const refreshQr = document.createElement('button');
  refreshQr.type = 'button';
  refreshQr.textContent = '刷新二维码';
  const closeBrowser = document.createElement('button');
  closeBrowser.type = 'button';
  closeBrowser.textContent = '关闭监控';
  const closeModal = document.createElement('button');
  closeModal.type = 'button';
  closeModal.textContent = '仅关闭弹窗';
  let removed = false;
  let polling = false;
  let timer = null;

  const cleanup = () => {
    removed = true;
    if (timer) clearInterval(timer);
    timer = null;
    overlay.remove();
  };

  const render = () => {
    title.textContent = `GCash：${current.email || ''}`;
    const status = String(current.status || '').toLowerCase();
    const modalFlow = deriveGcashViewModel({
      email: '',
      sessionAvailable: true,
      refiningJob: {
        result: { mkJobId: current.mkJobId || '', mkAccountId: current.mkAccountId || '' },
        gcashQr: current,
      },
    });
    const paymentStatus = modalFlow.paymentStatus;
    const expiresAt = Date.parse(String(current.qrExpiresAt || ''));
    const remainingSeconds = Number.isFinite(expiresAt)
      ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))
      : null;
    if (status === 'closing') {
      meta.textContent = '正在关闭当前支付监控…';
    } else if (modalFlow.plus) {
      meta.textContent = 'GC 已确认 Plus 到账，支付流程已完成。';
    } else if (paymentStatus === 'callback_processing') {
      meta.textContent = 'GC 回调已受理，正在确认 Plus 到账。';
    } else if (paymentStatus === 'redirect_captured') {
      meta.textContent = 'GC 已扫码/已跳转，准备回调。';
    } else if (['callback_failed', 'callback_unconfirmed', 'failed'].includes(paymentStatus)) {
      meta.textContent = `GC 流程失败：${current.error || current.authorizationError || current.gcashPostCheckoutError || modalFlow.detail || '未知错误'}`;
    } else if (paymentStatus === 'abandoned') {
      meta.textContent = modalFlow.refMissing ? '监控引用丢失，请重新提炼。' : '当前支付监控已关闭。';
    } else if (paymentStatus === 'refreshing' || paymentStatus === 'starting') {
      meta.textContent = '支付页已刷新，正在重新获取二维码…';
    } else if (paymentStatus === 'expired') {
      meta.textContent = modalFlow.canRefresh ? '二维码已过期；请点击“刷新二维码”获取新的二维码。' : '二维码已过期，当前监控不能刷新，请重新提炼。';
    } else if (paymentStatus === 'waiting_scan') {
        meta.textContent = `二维码有效，支付监控正在等待手机扫码${remainingSeconds === null ? '' : `；约 ${remainingSeconds} 秒后过期`}。`;
    } else {
        meta.textContent = '正在准备 GCash 付款链接和二维码监控。';
    }
    if (current.imageBase64) {
      const nextSrc = `data:${current.imageMime || 'image/png'};base64,${current.imageBase64}`;
      if (img.src !== nextSrc) img.src = nextSrc;
    }
    img.hidden = !(current.imageBase64 && gcashQrCanBeDisplayed(current, { refiningJob: { gcashQr: current } }));
      const paymentLink = current.url || current.sourceUrl || '';
      url.textContent = paymentLink;
      linkDetails.hidden = !paymentLink;
    refreshQr.hidden = !current.email || !modalFlow.canRefresh;
    refreshQr.disabled = status === 'refreshing' || status === 'closing';
    refreshQr.textContent = '刷新二维码';
    closeBrowser.disabled = !modalFlow.canClose || status === 'closing';
  };

  refreshQr.addEventListener('click', async () => {
    if (!current.email) return;
    refreshQr.disabled = true;
    current.status = 'refreshing';
    current.qrExpiresAt = null;
    render();
    try {
      const sourceUrl = String(current.sourceUrl || current.url || '').trim();
      const body = sourceUrl ? { url: sourceUrl } : {};
      const requested = await api.post(`/api/accounts/${encodeURIComponent(current.email)}/gcash/refresh`, body);
      if (requested.reason === 'already_active' && !requested.refreshed) {
        throw new Error('MK 正在处理当前二维码，请稍后再点刷新');
      }
      current.sessionId = requested.sessionId || current.sessionId;
      current.status = requested.status || 'refreshing';
      current.qrRefreshRequestedAt = requested.refreshRequestedAt || new Date().toISOString();
      render();
    } catch (error) {
      current.status = 'ready';
      current.refreshError = error.message;
      meta.textContent = `刷新二维码失败：${error.message}`;
      refreshQr.disabled = false;
    }
  });

  closeBrowser.addEventListener('click', async () => {
    if (!current.email) return;
    closeBrowser.disabled = true;
    current.status = 'closing';
    render();
    try {
      await api.post(`/api/accounts/${encodeURIComponent(current.email)}/gcash/close`, {});
      current.status = 'closed';
      current.authorizationStatus = 'closed_manually';
      current.browserAlive = false;
      render();
      await refresh({ silent: true });
    } catch (error) {
      current.status = 'ready';
        meta.textContent = `关闭支付监控失败：${error.message}`;
      closeBrowser.disabled = false;
    }
  });

  closeModal.addEventListener('click', cleanup);
  panel.append(title, meta, img, linkDetails, buttons);
  buttons.append(refreshQr, closeBrowser, closeModal);
  overlay.append(panel);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) cleanup();
  });
  document.body.append(overlay);
  render();

  timer = setInterval(async () => {
    if (!hasCapability('refining')) { cleanup(); return; }
    if (removed || polling || !current.email) return;
    polling = true;
    try {
      const latest = await api.get(`/api/accounts/${encodeURIComponent(current.email)}/gcash/status`);
      const qr = latest?.gcashQr || null;
      if (qr && (!current.sessionId || !qr.sessionId || qr.sessionId === current.sessionId)) {
        Object.assign(current, qr);
      } else if (qr?.sessionId && current.status === 'refreshing') {
        Object.assign(current, qr);
      }
      render();
    } catch {
      render();
    } finally {
      polling = false;
    }
  }, 1000);
}
async function waitForLiveGcashQr(email, sessionId, { timeoutMs = 90000, afterIssuedAt = '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  const issuedThreshold = Date.parse(String(afterIssuedAt || ''));
  let lastQr = null;
  while (Date.now() < deadline) {
    const result = await api.get(`/api/accounts/${encodeURIComponent(email)}/gcash/status`);
    const qr = result?.gcashQr || null;
    if (qr && (!sessionId || !qr.sessionId || qr.sessionId === sessionId)) {
      lastQr = qr;
      const issuedAt = Date.parse(String(qr.qrIssuedAt || qr.openedAt || ''));
      const isNewEnough = !Number.isFinite(issuedThreshold)
        || (Number.isFinite(issuedAt) && issuedAt >= issuedThreshold);
      if (qr.imageBase64 && isNewEnough && gcashQrCanBeDisplayed(qr, { refiningJob: { gcashQr: qr } })) return qr;
        const status = String(qr.status || '').toLowerCase();
        const authorizationStatus = String(qr.authorizationStatus || '').toLowerCase();
        const paymentStatus = gcashRawPaymentStatusFromQr(qr);
        if (['callback_failed', 'callback_unconfirmed', 'failed', 'abandoned'].includes(paymentStatus) || ['error', 'closed'].includes(status)
          || ['authorization_error', 'continue_failed', 'closed_manually'].includes(authorizationStatus)) {
          throw new Error(gcashQrStatusText({ email: '', refiningJob: { gcashQr: qr } }) || qr.error || 'GC 二维码生成失败');
        }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(lastQr?.refreshError || lastQr?.error || '等待 GC 二维码生成超时');
}

async function refreshGcashQrForEmail(entry) {
  if (!entry?.email) return;
  $('startFeedback').textContent = `正在刷新 GC 二维码：${entry.email}`;
  try {
    const scheduled = await api.post(`/api/accounts/${encodeURIComponent(entry.email)}/gcash/refresh`, {});
    if (scheduled.reason === 'already_active' && !scheduled.refreshed) {
      throw new Error('MK 正在处理当前二维码，请稍后再试');
    }
    $('startFeedback').textContent = `GC 二维码刷新中：${entry.email}`;
    const qr = await waitForLiveGcashQr(entry.email, scheduled.sessionId, {
      afterIssuedAt: scheduled.refreshRequestedAt || '',
    });
    showGcashQrModal({ email: entry.email, ...qr });
    await refresh({ silent: true });
    $('startFeedback').textContent = `GC 二维码已刷新；监控会保持到手动关闭或任务完成：${entry.email}`;
  } catch (error) {
    $('startFeedback').textContent = `刷新 GC 二维码失败：${error.message}`;
  }
}

async function viewGcashMonitorForEmail(entry, account = null) {
  if (!entry?.email) return;
  $('startFeedback').textContent = `正在读取 GC 监控：${entry.email}`;
  try {
    const latest = await api.get(`/api/accounts/${encodeURIComponent(entry.email)}/gcash/status`);
    const qr = latest?.gcashQr || account?.refiningJob?.gcashQr || null;
    if (!qr) {
      $('startFeedback').textContent = `当前没有 GC 监控：${entry.email}，请先提炼`;
      return;
    }
    showGcashQrModal({ email: entry.email, ...qr });
    $('startFeedback').textContent = `已打开 GC 监控：${entry.email}`;
  } catch (error) {
    $('startFeedback').textContent = `读取 GC 监控失败：${entry.email} · ${error.message}`;
  }
}

function createOpenGcashButton(entry, account) {
  const openGcash = document.createElement('button');
  openGcash.type = 'button';
  openGcash.className = 'primary-mini';
  const flow = deriveGcashViewModel(account);
  openGcash.textContent = flow.actions.open.label;
  openGcash.disabled = !flow.actions.open.enabled;
  openGcash.title = flow.actions.open.title;
  openGcash.addEventListener('click', (event) => {
    event.stopPropagation();
    if (openGcash.disabled) return;
    if (flow.actions.open.kind === 'view') {
      viewGcashMonitorForEmail(entry, account);
      return;
    }
    if (flow.actions.open.kind === 'refresh') {
      refreshGcashQrForEmail(entry);
    }
  });
  return openGcash;
}

function createCloseGcashMonitorButton(entry, account) {
  const flow = deriveGcashViewModel(account);
  if (!flow.actions.close.enabled) return null;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'danger-mini';
  close.textContent = flow.actions.close.label;
  close.title = flow.actions.close.title;
  close.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!entry?.email || close.disabled) return;
    close.disabled = true;
    const oldText = close.textContent;
    close.textContent = '关闭中';
    setMailRunAccountFeedback(entry.email, 'GC 正在关闭二维码监控…', { ttlMs: 15000 });
    try {
      await api.post(`/api/accounts/${encodeURIComponent(entry.email)}/gcash/close`, {});
      setMailRunAccountFeedback(entry.email, 'GC 二维码监控已关闭', { ttlMs: 30000 });
      await refresh({ silent: true });
    } catch (error) {
      close.disabled = false;
      close.textContent = oldText;
      setMailRunAccountFeedback(entry.email, `GC 关闭监控失败：${error.message}`);
    }
  });
  return close;
}

async function deleteOneEmail(entry) {
  if (!entry?.id) return;
  try {
    await api.delete(`/api/emails/${encodeURIComponent(entry.id)}`);
    state.selectedEmailIds.delete(entry.id);
    await refresh({ silent: true });
    $('startFeedback').textContent = `已删除邮箱：${entry.email}`;
  } catch (error) {
    $('startFeedback').textContent = `删除失败：${error.message}`;
  }
}

async function deleteWorkflowEmail(entry) {
  if (!entry?.email && !entry?.id) return;
  try {
    if (entry?.email) {
      await api.delete(`/api/accounts/${encodeURIComponent(entry.email)}/workflow`);
      state.selectedWorkflowEmails.delete(normalizeEmailKey(entry.email));
    } else {
      await api.delete(`/api/emails/${encodeURIComponent(entry.id)}`);
      state.selectedEmailIds.delete(entry.id);
    }
    await refresh({ silent: true });
    $('startFeedback').textContent = `已删除/归档：${entry.email || entry.id}`;
  } catch (error) {
    $('startFeedback').textContent = `删除/归档失败：${error.message}`;
  }
}

async function repairCredentialsForEmail(entry) {
  const key = normalizeEmailKey(entry?.email);
  if (!key || state.activeTaskStarts.has(key)) return;
  state.activeTaskStarts.add(key);
  renderEmailRunStatus();
  try {
    const result = await api.post(`/api/accounts/${encodeURIComponent(entry.email)}/credential-repair`, {
      proxyPoolId: proxyPoolPayload('main'),
    });
    $('startFeedback').textContent = `凭据修复已排队：${result.task?.id || entry.email}`;
    await refresh({ silent: true });
  } catch (error) {
    $('startFeedback').textContent = `凭据修复排队失败：${error.message}`;
  } finally {
    state.activeTaskStarts.delete(key);
    renderEmailRunStatus();
  }
}

async function retryOrStartRegistrationForEmail(entry, registrationView = null) {
  if (registrationView?.jobId && registrationViewAction(registrationView).label === '重试') {
    const key = normalizeEmailKey(entry.email);
    if (state.activeTaskStarts.has(key)) return;
    state.activeTaskStarts.add(key);
    renderEmailRunStatus();
    try {
      const result = await api.post(`/api/tasks/${encodeURIComponent(registrationView.jobId)}/retry`, {
        proxyPoolId: proxyPoolPayload('main'),
        ...registrationExecutionPayload(),
      });
      $('startFeedback').textContent = `已重新排队：${result.task?.id || registrationView.jobId}`;
      await refresh({ silent: true });
    } catch (error) {
      $('startFeedback').textContent = `重试失败：${error.message}`;
    } finally {
      state.activeTaskStarts.delete(key);
      renderEmailRunStatus();
    }
    return;
  }
  return startTaskForEmail(entry);
}

function emailInventoryItem(entry, { selectable = false } = {}) {
  const node = document.createElement('div');
  node.className = 'item inventory-item';
  const main = document.createElement('div');
  const canDelete = Boolean(entry.id && !entry.generatedTaskId);
  if (selectable && canDelete) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'email-select';
    checkbox.checked = state.selectedEmailIds.has(entry.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectedEmailIds.add(entry.id);
      else state.selectedEmailIds.delete(entry.id);
      updateEmailDeleteButton();
    });
    main.append(checkbox);
  }
  const title = document.createElement('strong');
  title.textContent = entry.email;
  const meta = document.createElement('code');
  meta.textContent = `${entry.status} · ${mailboxMeta(entry)}`;
  meta.className = 'mailbox-url';
  main.append(title, meta);
  const actions = document.createElement('div');
  actions.className = 'item-actions';
  const start = document.createElement('button');
  start.type = 'button';
  start.textContent = '启动';
  start.className = 'primary-mini';
  start.addEventListener('click', () => startTaskForEmail(entry));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '删除';
  remove.className = 'danger-mini';
  remove.disabled = !canDelete;
  remove.addEventListener('click', () => deleteOneEmail(entry));
  actions.append(start, remove);
  node.append(main, actions);
  return node;
}
function renderEmailInventory() {
  for (const button of document.querySelectorAll('[data-mail-category]')) {
    const category = button.dataset.mailCategory;
    const count = mailInventoryCount(category);
    button.classList.toggle('active', category === state.activeMailCategory);
    const labels = { ic: 'IC邮箱', domain: '域名邮箱', mail_com: 'mail邮箱' };
    button.textContent = `${labels[category] || '邮箱'} ${count}`;
  }
  for (const panel of document.querySelectorAll('[data-mail-panel]')) {
    panel.hidden = panel.dataset.mailPanel !== state.activeMailCategory;
  }
  const inventoryPane = $('emailInventoryPane');
  if (inventoryPane) inventoryPane.hidden = state.activeMailCategory !== 'ic';
  if (state.activeMailCategory !== 'ic') {
    updateEmailDeleteButton();
    return;
  }
  const entries = mailInventoryEntries().slice(0, 200);
  const emptyText = '暂无IC邮箱';
  const emptyMeta = '导入邮箱后会出现在这里';
  $('emailList').replaceChildren(...(entries.length
    ? entries.map((entry) => emailInventoryItem(entry, { selectable: true }))
    : [item({ title: emptyText, meta: emptyMeta })]));
  updateEmailDeleteButton();
}
function mailInventoryCount(category) {
  if (category === 'domain') return state.emails.filter(isDomainEmailEntry).length;
  if (category === 'mail_com') return Array.isArray(state.mailComAccounts) ? state.mailComAccounts.length : 0;
  return state.emails.filter((entry) => runEmailCategory(entry) === 'ic').length;
}
function trialEligibilityText(status) {
  if (status === 'eligible') return '有试用资格';
  if (status === 'not_eligible') return '无试用资格';
  if (status === 'unknown') return '资格未知';
  return status || '资格未知';
}
function eligibilityText(account) {
  if (!account) return '资格：未检测';
  if (account.eligibilityStatus === 'checking') return '资格：检测中';
  if (account.eligibilityError || account.eligibilityStatus === 'failed') {
    const previous = ['eligible', 'not_eligible'].includes(account.trialEligibility?.status)
      ? `（上次：${trialEligibilityText(account.trialEligibility.status)}）` : '';
    return `资格：检测失败${previous}`;
  }
  if (account.trialEligibility?.status) {
    return `资格：${trialEligibilityText(account.trialEligibility.status)}`;
  }
  return account.sessionAvailable ? '资格：可检测' : '资格：无 session';
}
function accountPlanLabel(status) {
  const normalized = String(status || '').trim().toLowerCase();
  const labels = {
    free: 'Free',
    plus: 'Plus',
    pro: 'Pro',
    team: 'Team',
    subscribed: '订阅中',
    guest: 'Guest',
    auth_stale: '登录态已过期',
    unknown: '未知',
    checking: '检测中',
    failed: '检测失败',
  };
  return labels[normalized] || (status || '未知');
}
function accountGcashConfirmedPlus(account) {
  const overview = gcashOverviewAccount(account?.email);
  if (String(overview?.state || '').trim().toLowerCase() === 'plus_confirmed') return true;
  return gcashRawPaymentStatusFromQr(account?.refiningJob?.gcashQr || null) === 'completed';
}
function accountPlanBriefText(account) {
  if (!account) return '账号：未检测';
  if (accountGcashConfirmedPlus(account)) return '账号：Plus';
  const status = String(account.accountPlan?.status || account.accountPlanStatus || '').trim().toLowerCase();
  if (status === 'checking') return '账号：检测中';
  if (status === 'failed') return '账号：检测失败';
  if (status === 'auth_stale') return '账号：登录态已过期';
  if (!status) return '账号：未检测';
  return `账号：${accountPlanLabel(status)}`;
}
function accountPlanStatusKey(account) {
  if (accountGcashConfirmedPlus(account)) return 'plus';
  return String(
    account?.accountPlan?.status
      || account?.accountPlanStatus
      || account?.refiningJob?.gcashQr?.detectedAccountPlanStatus
      || '',
  ).trim().toLowerCase();
}
function accountIsPlus(account) {
  return accountPlanStatusKey(account) === 'plus';
}
function accountPasswordStatus(account) {
  return account?.passwordStatus === 'has_password' ? 'has_password' : 'no_password';
}
function passwordStatusText(account) {
  if (!account || (account.status !== 'registered' && account.passwordStatus !== 'has_password')) return '密码：待注册';
  return accountPasswordStatus(account) === 'has_password'
    ? '密码：有'
    : '密码：无（不能后设）';
}
function accountHasTwoFactor(account) {
  return account?.totpStatus === 'enabled'
    || account?.hasTotp === true
    || Boolean(account?.totpSecret || account?.totpActiveFactorId);
}
function credentialExportUnavailableReason(account) {
  const missing = [];
  if (accountPasswordStatus(account) !== 'has_password') missing.push('密码');
  if (!accountHasTwoFactor(account)) missing.push('2FA');
  if (!missing.length) return '';
  if (missing.length === 2) return '复制账号需要该账号已有密码和 2FA';
  return missing[0] === '密码'
    ? '该账号没有密码，不能复制完整账号资料'
    : '该账号没有 2FA，不能复制完整账号资料';
}
function refiningStatusText(account) {
  const job = account?.refiningJob;
  if (!job?.status) return '';
  const labels = {
    pending: '待提炼',
    dispatching: '正在提交提炼',
    queued: '提炼排队中',
    running: `提炼中 ${Math.round(Number(job.percent || 0))}%`,
    done: '提炼成功',
    error: '提炼失败',
    cancelled: '提炼已停止',
    remote_unknown: '远端状态未知',
    remote_lost: '远端状态丢失',
  };
  return labels[job.status] || job.status;
}
// Workflow tab routing is product-gated, not error-code-gated.
// A row enters the next tab only when that tab's required artifact exists;
// otherwise it stays at the latest stage whose artifact is actually present.
function registrationAssetStatus(entry, account, registrationView) {
  const accountStatus = String(account?.status || '').trim().toLowerCase();
  const lifecycle = String(registrationView?.lifecycleStage || entry?.lifecycleStage || '').trim().toLowerCase();
  const regStatus = String(registrationView?.status || '').trim().toLowerCase();
  const registrationEvidence = account?.accessTokenAvailable === true || account?.sessionAvailable === true;
  const credentialsReady = (account?.passwordStatus === 'has_password' || Boolean(account?.password))
    && (account?.totpStatus === 'enabled' || account?.hasTotp === true || Boolean(account?.totpSecret || account?.totpActiveFactorId))
    && (account?.accessTokenAvailable === true || account?.accessTokenLiveCheck?.status === 'valid' || Boolean(account?.tokens?.accessToken));
  return accountStatus === 'registered'
    || registrationEvidence
    || credentialsReady
    || regStatus === 'completed'
    || ['registered', 'eligibility', 'payment_method', 'refining', 'gcash', 'pending_payment', 'paid', 'completed', 'plus', 'sold'].includes(lifecycle);
}

function registrationAssetPasswordStatus(entry, account, registrationView) {
  return String(
    account?.passwordStatus
      || registrationView?.passwordStatus
      || entry?.passwordStatus
      || '',
  ).trim().toLowerCase();
}

function registrationAssetTotpStatus(entry, account, registrationView) {
  return String(
    account?.totpStatus
      || registrationView?.totpStatus
      || entry?.totpStatus
      || '',
  ).trim().toLowerCase();
}

function registrationAssetEligibilityStatus(entry, account, registrationView) {
  return String(
    account?.trialEligibility?.status
      || account?.eligibilityStatus
      || registrationView?.eligibilityStatus
      || entry?.eligibilityStatus
      || '',
  ).trim().toLowerCase();
}

function registrationAssetPaymentMethodStatus(entry, account, registrationView) {
  return String(
    account?.paymentCapabilities?.status
      || registrationView?.paymentMethodStatus
      || entry?.paymentMethodStatus
      || '',
  ).trim().toLowerCase();
}

function registrationExtraSettings() {
  return state.registrationChangeEmailSettings || state.config?.registration?.changeEmail || {};
}

function registrationRequiresPassword() {
  return registrationExtraSettings().setupPassword === true;
}

function registrationRequiresTotp() {
  return registrationExtraSettings().setupTotp2fa === true;
}

function registrationSourceKind(entry, account = null) {
  return entry?.mailboxSource === 'mail_com_split' || account?.source === 'mail_com_split' ? 'mail' : 'other';
}

function taskIsActive(summary = {}) {
  return ['staged', 'queued', 'running', 'waiting_mail', 'retry_waiting'].includes(
    String(summary.status || '').trim().toLowerCase(),
  );
}

function taskIsFailed(summary = {}, registrationView = null) {
  const status = String(registrationView?.status || summary.status || '').trim().toLowerCase();
  return ['failed', 'cancelled', 'blocked'].includes(status);
}

function repairFailureStage(entry, account, registrationView) {
  if (!registrationAssetStatus(entry, account, registrationView)) return '注册';
  const passwordReady = registrationAssetPasswordStatus(entry, account, registrationView) === 'has_password';
  const totpReady = registrationAssetTotpStatus(entry, account, registrationView) === 'enabled';
  if (!passwordReady) return '密码和 2FA';
  if (!totpReady) return '2FA';
  return '注册';
}

function paymentMethodList(account = {}) {
  const methods = Array.isArray(account?.paymentCapabilities?.methods) ? account.paymentCapabilities.methods : [];
  return [...new Set(methods.map((method) => String(method || '').trim().toLowerCase()).filter(Boolean))];
}

function paymentMethodLabel(account = {}) {
  const methods = paymentMethodList(account);
  return methods.length ? methods.join(' / ') : '未发现';
}

function paymentCheckoutType(account = {}) {
  return String(
    account?.paymentCapabilities?.checkoutType
      || account?.paymentCapabilities?.sessionType
      || account?.refiningJob?.config?.linkType
      || '',
  ).trim().toLowerCase();
}

function accountHasUsablePaymentMethod(account = {}) {
  const probe = String(account?.paymentCapabilities?.status || account?.paymentMethodStatus || '').trim().toLowerCase();
  return ['done', 'available'].includes(probe) && paymentMethodList(account).length > 0;
}

function baTokenFromAccount(account = {}) {
  const job = account?.refiningJob || {};
  const result = job.result || {};
  const found = collectWorkflowStrings([
    job.baToken,
    job.resultUrl,
    result.ba_token,
    result.billing_token,
    result.checkout_url,
    result.provider_redirect_url,
    result.stripe_redirect_url,
    result.url,
    result,
  ]).find((value) => /BA-[A-Za-z0-9]{8,80}/u.test(String(value || '')));
  const match = String(found || '').match(/BA-[A-Za-z0-9]{8,80}/u);
  return match?.[0] || '';
}

function firstResultUrl(account = {}) {
  const job = account?.refiningJob || {};
  const result = job.result || {};
  const direct = [
    job.resultUrl,
    result.short_link,
    result.checkout_url,
    result.provider_redirect_url,
    result.adyen_redirect_url,
    result.payment_redirect_url,
    result.paypal_link,
    result.paypal_url,
    result.stripe_redirect_url,
    result.verification_url,
    result.redirect_url,
    result.payment_url,
    result.url,
    result.link,
    job.gcashQr?.sourceUrl,
    job.gcashQr?.url,
  ].map((value) => String(value || '').trim()).find((value) => /^https?:\/\//iu.test(value));
  if (direct) return direct;
  return collectWorkflowStrings(result).find((value) => /^https?:\/\//iu.test(String(value || '').trim())) || '';
}

function paymentArtifactInfo(account = {}) {
  const ba = baTokenFromAccount(account);
  if (ba) return { type: 'BA', value: ba };
  const url = firstResultUrl(account);
  if (url) {
    const lower = url.toLowerCase();
    const type = lower.includes('gcash') ? 'GCash 链接' : lower.includes('paypal') ? 'PayPal 链接' : '支付链接';
    return { type, value: url };
  }
  const qr = account?.refiningJob?.gcashQr || {};
  if (qr.imageBase64 || qr.mkJobId || qr.mkAccountId) return { type: 'GCash QR', value: qr.url || qr.sourceUrl || qr.mkJobId || '' };
  return { type: '', value: '' };
}

function accountHasUsablePaymentArtifact(account = {}) {
  const artifact = paymentArtifactInfo(account);
  return Boolean(artifact.type && (artifact.value || artifact.type === 'GCash QR'));
}

function registrationDateKey(row = {}) {
  const entry = row.entry || {};
  const account = row.account || {};
  const task = row.task || {};
  const registrationView = row.registrationView || {};
  const value = account.registrationCompletedAt
    || account.registeredAt
    || task.completedAt
    || registrationView.completedAt
    || account.createdAt
    || entry.createdAt
    || '';
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '未知日期';
  return date.toISOString().slice(0, 10);
}

function soldSubstage(account = {}, entry = {}) {
  account = account || {};
  entry = entry || {};
  const saved = String(account.soldSmsStatus || entry.soldSmsStatus || account.soldPhoneBindStatus || '').trim().toLowerCase();
  if (['sms', 'completed', 'done', 'bound'].includes(saved)) return 'sms';
  if (['unsms', 'pending', 'none'].includes(saved)) return 'unsms';
  return accountPhoneBindCompleted(account) ? 'sms' : 'unsms';
}

function accountWorkflowStage(entry, task, account, registrationView = null) {
  const serverStage = String(registrationView?.workflowStage || '').trim().toLowerCase();
  if (serverStage) return visibleWorkflowStage(serverStage);
  const summary = taskSummary(task, registrationView);
  const saved = String(account?.workflowStage || account?.mailComStage || entry?.mailComStage || '').trim().toLowerCase();
  const taskStatus = String(registrationView?.status || summary.status || '').trim().toLowerCase();
  const activeTask = ['staged', 'queued', 'running', 'waiting_mail', 'retry_waiting'].includes(taskStatus);
  const failedTask = ['failed', 'cancelled', 'blocked'].includes(taskStatus);
  const registered = registrationAssetStatus(entry, account, registrationView);
  const passwordReady = registrationAssetPasswordStatus(entry, account, registrationView) === 'has_password';
  const totpReady = registrationAssetTotpStatus(entry, account, registrationView) === 'enabled';
  const liveCheck = String(account?.accessTokenLiveCheck?.status || '').trim().toLowerCase();
  const tokenPresent = account?.accessTokenAvailable === true || Boolean(account?.tokens?.accessToken);
  const tokenInvalid = ['invalid', 'failed'].includes(liveCheck);
  const splitMailbox = String(entry?.mailboxSource || account?.source || '').trim().toLowerCase() === 'mail_com_split';
  const trialStatus = registrationAssetEligibilityStatus(entry, account, registrationView);
  const paymentArtifact = accountHasUsablePaymentArtifact(account);
  const paymentSettled = paymentArtifact && (
    accountPaymentCompleted(account)
      || ['paid', 'sms', 'completed', 'sold'].includes(saved)
  );
  const completedReady = paymentSettled && accountCompletedReady(account);

  // Historical task status is diagnostic only once the account has real assets.
  if (!registered) {
    if (activeTask) return 'registering';
    return failedTask ? 'registration_failed' : 'preparing';
  }
  if (!splitMailbox && (!passwordReady || !totpReady || !tokenPresent || tokenInvalid || !account?.sessionAvailable)) return 'repair';
  if (trialStatus === 'checking' || trialStatus === 'unknown' || trialStatus === 'failed' || !trialStatus) return 'eligibility';
  if (trialStatus === 'not_eligible') return 'discarded';
  if (trialStatus !== 'eligible') return 'eligibility';

  if (!hasCapability('payment') && !hasCapability('refining') && !hasCapability('paymentMethodProbe')) return saved === 'sold' ? 'sold' : 'completed';

  if (saved === 'sold') return 'sold';
  if (saved === 'completed' || completedReady) return 'completed';
  if (saved === 'paid' || saved === 'sms' || accountPhoneBindInProgress(account) || paymentSettled) return 'paid';
  if (!accountHasUsablePaymentMethod(account)) return 'payment_method';
  if (paymentArtifact) return 'unpaid';
  return 'refining';
}
function phoneBindAutoStatusText(account) {
  const status = String(account?.phoneBindStatus || '').trim().toLowerCase();
  const attempt = Math.max(0, Number(account?.phoneBindSmsAttempt || 0));
  const limit = Math.max(1, Number(state.phoneBindSettings?.smsPhoneRetryLimit ?? 2) + 1);
  if (status === 'queued') {
    const position = Number(account?.phoneBindQueuePosition || 0);
    return position > 0 ? `自动接码排队中（第 ${position} 位）` : '自动接码排队中…';
  }
  if (status === 'retry_wait') {
    const retryAt = Date.parse(account?.phoneBindNextRetryAt || '');
    const waitSeconds = Number.isFinite(retryAt)
      ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000))
      : 0;
    const kind = account?.phoneBindRetryKind === 'rate_limit' ? '请求限流冷却' : '准备下一次尝试';
    return `${kind}${waitSeconds ? ` ${waitSeconds} 秒` : ''} · 已取号 ${attempt}/${limit}`;
  }
  if (status === 'rt_pending') return '手机号已绑定，等待获取 RT…';
  if (status === 'otp_required') return `自动等待验证码… · 已取号 ${attempt}/${limit}`;
  if (status === 'starting') return `自动取号中… · 已取号 ${attempt}/${limit}`;
  return '等待自动接码…';
}
async function startPaymentForEmail(entry) {
  if (!entry?.email) return;
  const key = String(entry.email || '').trim().toLowerCase();
  if (state.activePaymentStarts.has(key)) return;
  const previousPayment = state.accounts.find((account) => (
    String(account.email || '').trim().toLowerCase() === key
  ))?.payment || {};
  const retrying = ['failed', 'cancelled'].includes(String(previousPayment.status || '').toLowerCase());
  state.activePaymentStarts.add(key);
  renderEmailRunStatus();
  $('startFeedback').textContent = `正在启动支付：${entry.email}`;
  try {
    const result = await api.post(`/api/accounts/${encodeURIComponent(entry.email)}/payment/start`, {});
    const accountIndex = state.accounts.findIndex((account) => String(account.email || '').trim().toLowerCase() === key);
    if (accountIndex >= 0 && result.payment) {
      state.accounts[accountIndex] = { ...state.accounts[accountIndex], payment: result.payment };
    }
    const newJobId = String(result.payment?.jobId || '');
    const createdNewJob = Boolean(newJobId && newJobId !== String(previousPayment.jobId || ''));
    const liveStatus = paymentStatusText({ payment: result.payment }) || '支付任务已受理';
    const immediateFailure = String(result.payment?.status || '').toLowerCase() === 'failed';
    const immediateError = paymentErrorText(result.payment?.error || '');
    $('startFeedback').textContent = retrying && createdNewJob && immediateFailure
      ? `已创建新支付任务，但再次失败：${entry.email} · ${immediateError || liveStatus}`
      : retrying && createdNewJob
        ? `已创建新支付任务并重新申请手机号：${entry.email} · ${liveStatus}`
      : retrying
        ? `支付任务仍在进行：${entry.email} · ${liveStatus}`
        : `支付已启动：${entry.email} · ${liveStatus}`;
    renderEmailRunStatus();
    refresh({ silent: true }).catch(() => {});
  } catch (error) {
    $('startFeedback').textContent = `支付启动失败：${error.message}`;
  } finally {
    state.activePaymentStarts.delete(key);
    renderEmailRunStatus();
  }
}
function paymentCapabilityText(account) {
  const probe = account?.paymentCapabilities;
  const status = String(probe?.status || '').toLowerCase();
  if (!status) return '';
  if (status === 'queued') return '支付方式待检测';
  if (status === 'checking') return '支付方式检测中';
  if (status === 'failed') return `支付方式检测失败：${shortStatusText(probe?.error || 'unknown', 80)}`;
  if (status === 'done') {
    const methods = Array.isArray(probe.methods) ? probe.methods.filter(Boolean) : [];
    const checkoutType = String(probe.checkoutType || probe.sessionType || '').trim();
    const suffix = checkoutType ? ` · ${checkoutType}` : '';
    return methods.length ? `支付方式：${methods.join('/')}${suffix}` : `支付方式：未发现${suffix}`;
  }
  return `支付方式：${status}`;
}

function paymentStatusText(account) {
  const payment = account?.payment;
  if (!payment?.status) return '';
  const labels = {
    starting: '支付准备中',
    running: '支付中',
    awaiting_otp: '等待自动接码',
    awaiting_captcha: 'PayPal 风控验证',
    completed: '支付完成',
    failed: '支付失败',
    cancelled: '支付已停止',
  };
  return labels[payment.status] || payment.status;
}
function paymentErrorText(value = '') {
  const text = sanitizeStatusText(value);
  if (/\bNO_BALANCE\b/iu.test(text)) {
    return 'SMSBower 余额不足；请充值后再次点击重试支付';
  }
  if (/\bNO_NUMBERS\b/iu.test(text)) {
    return 'SMSBower 当前国家和价格区间暂无可用号码；请稍后重试或调整接码配置';
  }
  return text;
}

function mailComStageLabel(stage) {
  const labels = {
    preparing: '准备阶段',
    registering: '注册中',
    repair: '待修复',
    repair_verification: '收件箱待验证',
    unrepairable: '不可修复',
    eligibility: '测资格',
    discarded: '无试用资格',
    payment_method: '支付方式待定',
    refining: '提炼',
    unpaid: '未支付',
    paid: '已支付',
    completed: '已完成',
    sold: '已售',
  };
  return labels[stage] || stage || '任务';
}
function paymentCapabilityBriefText(account) {
  const probe = account?.paymentCapabilities;
  const status = String(probe?.status || '').toLowerCase();
  if (!status) return '支付方式：未检测';
  if (status === 'queued') return '支付方式：待检测';
  if (status === 'checking') return '支付方式：检测中';
  if (status === 'failed') return '支付方式：检测失败';
  if (status === 'done') {
    const methods = Array.isArray(probe.methods) ? probe.methods.filter(Boolean) : [];
    const checkoutType = String(probe.checkoutType || probe.sessionType || '').trim();
    const suffix = checkoutType ? ` · ${checkoutType}` : '';
    return methods.length ? `支付方式：${methods.join('/')}${suffix}` : `支付方式：未发现${suffix}`;
  }
  return `支付方式：${status}`;
}
function accountHasGcashPaymentMethod(account) {
  const probeStatus = String(account?.paymentCapabilities?.status || '').trim().toLowerCase();
  const methods = Array.isArray(account?.paymentCapabilities?.methods) ? account.paymentCapabilities.methods : [];
  return probeStatus === 'done' && methods.some((method) => String(method || '').trim().toLowerCase() === 'gcash');
}
function accountTrialStatus(account) {
  return String(
    account?.trialEligibility?.status
      || account?.eligibilityStatus
      || '',
  ).trim().toLowerCase();
}
function accountTrialEligible(account) {
  return accountTrialStatus(account) === 'eligible';
}
function accountPhoneOauthQualified(account) {
  return account?.phoneBindOauthQualified === true
    || account?.phoneBindOauthQualification?.qualified === true
    || (account?.phoneBindOauthQualification?.accountSelectReached === true
      && account?.phoneBindOauthQualification?.addPhoneReached === true);
}
function accountHasAccessToken(account) {
  return account?.accessTokenAvailable === true;
}
function accountIsRegistered(account) {
  return account?.status === 'registered'
    || account?.registrationStatus === 'registered'
    || account?.isRegistered === true
    || account?.registered === true;
}
function accountCanEnterPostRegistration(account) {
  return accountIsRegistered(account)
    && accountTrialEligible(account)
    && accountHasAccessToken(account);
}
function collectWorkflowStrings(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectWorkflowStrings(item, output);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectWorkflowStrings(item, output);
  }
  return output;
}
function accountPaymentCompleted(account) {
  return String(account?.payment?.status || '').trim().toLowerCase() === 'completed'
    || String(account?.paymentStatus || '').trim().toLowerCase() === 'paid';
}
function accountPhoneBindCompleted(account) {
  return String(account?.phoneBindStatus || '').trim().toLowerCase() === 'completed';
}
function accountPhoneBindInProgress(account) {
  return ['queued', 'retry_wait', 'rt_pending', 'starting', 'otp_required', 'failed'].includes(
    String(account?.phoneBindStatus || '').trim().toLowerCase(),
  );
}

function gcashTraceBrief(qr) {
  const trace = Array.isArray(qr?.gcashTrace) ? qr.gcashTrace : [];
  if (!trace.length) return '';
  const last = [...trace].reverse().find((event) => event && event.type !== 'open');
  if (!last) return '';
  const kind = String(last.kind || '').replace(/^chatgpt_/u, 'chatgpt ').replace(/^gcash_/u, 'gcash ');
  const op = String(last.operationType || '').split('.').slice(-2).join('.');
  const status = last.status ? ` ${last.status}` : '';
  if (op) return `最后：${op}${status}`;
  if (kind) return `最后：${kind}${status}`;
  return '';
}


const MK_GCASH_ACTIVE_REFINING_STATUSES = new Set([
  'dispatching', 'queued', 'running', 'remote_unknown', 'remote_lost',
]);
const MK_GCASH_ACTIVE_PAYMENT_STATUSES = new Set([
  'starting', 'waiting_scan', 'refreshing', 'redirect_captured', 'callback_processing',
]);
const MK_GCASH_ABANDONABLE_PAYMENT_STATUSES = new Set([
  'starting', 'waiting_scan', 'refreshing', 'redirect_captured', 'callback_processing', 'expired',
]);

function gcashReasonLabel(reason) {
  const key = String(reason || '').trim().toLowerCase();
  const labels = {
      pending: '等待提炼',
      queued: '等待提炼',
      dispatching: '提交提炼',
      running: '执行提炼',
      remote_unknown: '提交状态未知，等待确认',
      remote_lost: '远端状态丢失，等待恢复',
    starting: '正在打开支付页',
    extracting: '正在获取二维码',
    waiting_scan: '等待扫码',
    refreshing: '正在刷新二维码',
    redirect_captured: '已扫码，准备回调',
    callback_processing: '回调已受理，正在确认 Plus',
    callback_unconfirmed: 'Plus 权益未确认',
    callback_failed: '自动回调失败',
    qr_expired: '二维码已过期',
    expired: '二维码已过期',
    abandoned: '已放弃支付监控',
    closed: '已放弃支付监控',
    monitor_ref_missing: '监控引用丢失，需重提',
    unavailable: '仅付款链接',
    configure_taxes: '配置税务中',
    confirm_payment: '确认支付中',
    proxy_test: '代理测试中',
    completed: '支付成功',
    plus_confirmed: '支付成功',
    not_started: '未开始',
    idle: '未开始',
    failed: '执行失败',
    mk_task_failed: '执行失败',
  };
  return labels[key] || key || '执行失败';
}

function gcashOverviewAccount(email) {
  const key = normalizeEmailKey(email);
  if (!key) return null;
  const accounts = state.refining?.gcash?.accounts || [];
  return accounts.find((account) => normalizeEmailKey(account.email) === key) || null;
}

function gcashMkRef(account) {
  const result = account?.refiningJob?.result || {};
  const qr = account?.refiningJob?.gcashQr || {};
  const mkJobId = String(result.mkJobId || qr.mkJobId || '').trim();
  const mkAccountId = String(result.mkAccountId || qr.mkAccountId || '').trim();
  return mkJobId && mkAccountId ? { mkJobId, mkAccountId } : null;
}

function gcashQrExpiryText(qr) {
  const expiresAt = Date.parse(String(qr?.qrExpiresAt || ''));
  if (!Number.isFinite(expiresAt)) return '';
  const seconds = Math.ceil((expiresAt - Date.now()) / 1000);
  if (seconds <= 0) return '已过期';
  if (seconds < 60) return `${seconds}秒后过期`;
  return `${Math.ceil(seconds / 60)}分钟内过期`;
}

function gcashRawPaymentStatusFromQr(qr) {
  const status = String(qr?.status || '').trim().toLowerCase();
  const postStatus = String(qr?.gcashPostCheckoutStatus || '').trim().toLowerCase();
  const mkStatus = String(qr?.mkPaymentStatus || qr?.gcashStateReason || postStatus || '').trim().toLowerCase();
  const explicit = String(qr?.gcashState || '').trim().toLowerCase();
  if (qr?.gcashConfirmedPlus === true || postStatus === 'plus_confirmed' || mkStatus === 'completed' || status === 'completed') return 'completed';
  if (['callback_failed', 'callback_unconfirmed'].includes(mkStatus)) return mkStatus;
  if (['failed', 'mk_task_failed'].includes(mkStatus) || status === 'error' || explicit === 'failed') return 'failed';
  if (['abandoned', 'monitor_ref_missing'].includes(mkStatus) || status === 'closed' || explicit === 'closed') return 'abandoned';
  if (mkStatus === 'expired' || status === 'expired' || explicit === 'qr_expired' || gcashQrIsExpired(qr)) return 'expired';
  if (mkStatus === 'callback_processing' || explicit === 'confirming') return 'callback_processing';
  if (mkStatus === 'redirect_captured' || explicit === 'scanned') return 'redirect_captured';
  if (mkStatus === 'waiting_scan' || status === 'ready' || explicit === 'qr_ready') return 'waiting_scan';
  if (mkStatus === 'refreshing' || status === 'refreshing') return 'refreshing';
  if (mkStatus === 'starting' || status === 'capturing' || explicit === 'extracting') return 'starting';
  return 'unavailable';
}

function gcashPaymentStatusFromCanonical(overview, qr) {
  const stateValue = String(overview?.state || '').trim().toLowerCase();
  const reason = String(overview?.reason || overview?.stage || '').trim().toLowerCase();
  const stage = String(overview?.stage || '').trim().toLowerCase();
  const value = reason || stage || stateValue;
  if (['completed', 'plus_confirmed'].includes(value) || stateValue === 'plus_confirmed') return 'completed';
  if (['callback_failed', 'callback_unconfirmed'].includes(value)) return value;
  if (['failed', 'mk_task_failed'].includes(value) || stateValue === 'failed') return 'failed';
  if (['abandoned', 'closed', 'monitor_ref_missing'].includes(value) || stateValue === 'closed') return 'abandoned';
  if (['expired', 'qr_expired'].includes(value) || stateValue === 'qr_expired') return 'expired';
  if (['redirect_captured', 'scanned'].includes(value) || stateValue === 'scanned') return 'redirect_captured';
  if (['callback_processing', 'confirming'].includes(value) || stateValue === 'confirming') return 'callback_processing';
  if (['waiting_scan', 'qr_ready'].includes(value) || stateValue === 'qr_ready') return 'waiting_scan';
  if (value === 'refreshing') return 'refreshing';
  if (['starting', 'extracting', 'pending', 'queued', 'dispatching', 'running', 'remote_unknown', 'remote_lost', 'configure_taxes', 'confirm_payment', 'proxy_test'].includes(value) || stateValue === 'extracting') return 'starting';
  return gcashRawPaymentStatusFromQr(qr);
}

function gcashUiStateFromPayment(paymentStatus, jobActive = false) {
  if (jobActive || ['starting', 'refreshing'].includes(paymentStatus)) return 'extracting';
  if (paymentStatus === 'completed') return 'plus_confirmed';
  if (paymentStatus === 'waiting_scan') return 'qr_ready';
  if (paymentStatus === 'expired') return 'qr_expired';
  if (paymentStatus === 'redirect_captured') return 'scanned';
  if (paymentStatus === 'callback_processing') return 'confirming';
  if (['callback_failed', 'callback_unconfirmed', 'failed'].includes(paymentStatus)) return 'failed';
  if (paymentStatus === 'abandoned') return 'closed';
  return 'idle';
}

function gcashPaymentLabel(paymentStatus, account, context = {}) {
  if (context.paymentSuccess) return ['支付成功', 'complete'];
  if (context.jobActive) return ['未开始', 'neutral'];
  const qrReady = Boolean(context.qrReady);
  const refreshAvailable = Boolean(context.refreshAvailable);
  const refMissing = Boolean(context.refMissing);
  const labels = {
    starting: ['正在打开支付页', 'pending'],
    waiting_scan: [qrReady ? '等待扫码' : '正在获取二维码', 'waiting'],
    refreshing: ['正在刷新二维码', 'pending'],
    redirect_captured: ['已扫码，准备回调', 'pending'],
    callback_processing: ['回调已受理，正在确认 Plus', 'pending'],
    callback_failed: ['自动回调失败', 'failed'],
    callback_unconfirmed: ['Plus 权益未确认', 'failed'],
    expired: [refreshAvailable ? '二维码已过期，可刷新' : '支付监控已结束', 'expired'],
    abandoned: [refMissing ? '监控引用丢失，需重提' : '已放弃支付监控', 'neutral'],
    failed: ['执行失败', 'failed'],
      unavailable: [context.linkReady ? '仅付款链接' : (context.hasMonitor ? '未生成二维码' : '未开始'), 'neutral'],
  };
  return labels[paymentStatus] || labels.unavailable;
}

function deriveGcashViewModel(account) {
  const qr = account?.refiningJob?.gcashQr || null;
  const overview = gcashOverviewAccount(account?.email);
  const ref = gcashMkRef(account);
  const hasMonitor = Boolean(ref);
  const reason = String(overview?.reason || overview?.stage || '').trim().toLowerCase();
  const stateValue = String(overview?.state || '').trim().toLowerCase();
    const refiningStatus = String(overview?.refiningStatus || account?.refiningJob?.status || '').trim().toLowerCase();
  const paymentStatus = gcashPaymentStatusFromCanonical(overview, qr);
  const paymentSuccess = paymentStatus === 'completed' || accountGcashConfirmedPlus(account);
  const refreshAvailable = Boolean(qr?.refreshAvailable || overview?.refreshAvailable);
  const qrFresh = Boolean(qr?.imageBase64) && !gcashQrIsExpired(qr);
    const linkReady = Boolean(qr?.url || qr?.sourceUrl || account?.refiningJob?.result?.checkout_url || account?.refiningJob?.result?.url);
  const qrReady = hasMonitor && paymentStatus === 'waiting_scan' && qrFresh;
  const refMissing = !hasMonitor && (reason === 'monitor_ref_missing' || Boolean(qr && (qr.imageBase64 || qr.status || qr.gcashStateReason || qr.mkPaymentStatus)));
    const jobActive = MK_GCASH_ACTIVE_REFINING_STATUSES.has(refiningStatus)
      || stateValue === 'extracting'
      || MK_GCASH_ACTIVE_REFINING_STATUSES.has(reason)
      || ['starting', 'refreshing', 'configure_taxes', 'confirm_payment', 'proxy_test'].includes(reason);
  const paymentActive = MK_GCASH_ACTIVE_PAYMENT_STATUSES.has(paymentStatus)
    || (paymentStatus === 'expired' && refreshAvailable);
  const activeMonitor = hasMonitor && paymentActive && !paymentSuccess;
  const canRefresh = hasMonitor && refreshAvailable && ['waiting_scan', 'expired'].includes(paymentStatus) && !paymentSuccess;
  const canClose = hasMonitor && MK_GCASH_ABANDONABLE_PAYMENT_STATUSES.has(paymentStatus) && !paymentSuccess;
  const canView = hasMonitor && (qrReady || ['waiting_scan', 'expired', 'redirect_captured', 'callback_processing', 'callback_failed', 'callback_unconfirmed', 'failed', 'completed'].includes(paymentStatus));
  const needsReextract = !jobActive && !paymentSuccess && !activeMonitor && (!hasMonitor || ['abandoned', 'failed', 'callback_failed', 'callback_unconfirmed', 'unavailable'].includes(paymentStatus));
  const uiState = gcashUiStateFromPayment(paymentStatus, jobActive);
  const payment = gcashPaymentLabel(paymentStatus, account, {
    paymentSuccess,
    qrReady,
    refreshAvailable,
    refMissing,
      linkReady,
      hasMonitor,
      jobActive,
  });
  const visual = gcashVisualStatusFromState(uiState);
  const refineLabel = jobActive
    ? '提链中'
      : (paymentSuccess ? '已Plus' : (hasMonitor && !needsReextract ? '提链成功' : (needsReextract && (paymentStatus !== 'unavailable' || hasMonitor || refMissing) ? '重新提炼' : '提炼')));
  const monitorLabel = payment[0];
    const openKind = (qrReady || paymentSuccess) ? 'view'
      : (canRefresh ? 'refresh'
        : (canView ? 'view' : 'none'));
  const openLabel = jobActive ? '获取中'
    : (paymentSuccess ? '查看结果'
      : (qrReady ? '查看二维码'
        : (canRefresh ? '刷新二维码'
          : (canView ? '查看监控'
            : (paymentStatus === 'abandoned' ? '已关闭' : (needsReextract ? '无监控' : '先提炼'))))));
  return {
    source: overview ? 'overview' : 'local_qr',
    overview,
    qr,
    ref,
    hasMonitor,
    state: uiState,
    uiState,
    visual,
    paymentStatus,
    paymentTone: payment[1],
    label: monitorLabel,
    reason: reason || paymentStatus,
    detail: overview?.detail || qr?.error || qr?.authorizationError || qr?.gcashPostCheckoutError || account?.refiningJob?.error || '',
    jobStatus: jobActive ? 'running' : (paymentSuccess || hasMonitor ? 'success' : (uiState === 'failed' ? 'failed' : 'idle')),
    jobActive,
    paymentActive,
    activeMonitor,
    extracting: jobActive,
    plus: paymentSuccess,
    closed: paymentStatus === 'abandoned',
    qrReady,
    refMissing,
    refreshAvailable,
    canRefresh,
    canClose,
    canView,
    needsReextract,
    refineLabel,
    monitorLabel,
    expiry: gcashQrExpiryText(qr),
      statusText: jobActive
        ? `GC 提炼中：${gcashReasonLabel(refiningStatus || reason)}`
        : `GC ${monitorLabel}${overview?.detail && ['failed'].includes(uiState) ? `：${shortStatusText(overview.detail, 80)}` : ''}`,
    actions: {
      refine: {
        enabled: !jobActive && !paymentSuccess && !activeMonitor,
        label: refineLabel,
        title: jobActive
          ? 'MK 正在执行提链，完成后进入二维码/回调监控'
          : (paymentSuccess
            ? 'MK GCash 已确认 Plus，不需要重新提炼'
            : (activeMonitor
              ? '提链已完成；当前还有支付监控，请刷新/查看二维码或关闭监控'
              : (needsReextract ? '创建新的 MK GCash 提链任务' : '创建 MK GCash 提链任务'))),
      },
      open: {
        kind: openKind,
          enabled: openKind === 'view' || openKind === 'refresh',
        label: openLabel,
        title: openKind === 'view'
          ? '查看当前 MK GCash 二维码/回调状态'
          : (openKind === 'refresh'
              ? '调用 MK GCash 刷新当前支付页面二维码'
            : (paymentStatus === 'abandoned' ? '当前支付监控已关闭；如需继续请重新提炼' : '当前没有可管理的 MK GCash 监控')),
      },
      close: {
        enabled: canClose,
        label: '关闭监控',
        title: '放弃当前 MK GCash 二维码/回调监控；不会创建新的提链任务',
      },
    },
  };
}

function accountGcashStateInfo(account) {
  return deriveGcashViewModel(account);
}

function gcashVisualStatusFromState(state) {
  const value = String(state || '').trim().toLowerCase();
  if (value === 'plus_confirmed') return 'success';
  if (['extracting', 'qr_ready', 'scanned', 'confirming'].includes(value)) return 'active';
  if (value === 'failed') return 'failed';
  if (value === 'qr_expired') return 'expired';
  if (value === 'closed') return 'closed';
  return 'idle';
}

function gcashMkPaymentLabel(qr, fallbackState = '') {
  const paymentStatus = gcashRawPaymentStatusFromQr(qr);
  const state = String(fallbackState || '').trim().toLowerCase();
  const label = gcashPaymentLabel(paymentStatus === 'unavailable' && state === 'extracting' ? 'starting' : paymentStatus, null, {
    paymentSuccess: paymentStatus === 'completed',
    qrReady: Boolean(qr?.imageBase64) && !gcashQrIsExpired(qr),
    refreshAvailable: Boolean(qr?.refreshAvailable),
    refMissing: false,
    linkReady: Boolean(qr?.url || qr?.sourceUrl),
  });
  return label[0];
}

function gcashFlowInfo(account) {
  return deriveGcashViewModel(account);
}

function gcashQrStatusText(account) {
  return deriveGcashViewModel(account).statusText;
}

function accountCompletedReady(account) {
  return accountPhoneBindCompleted(account);
}
function accountCoreInfoParts(account) {
  return [eligibilityText(account), accountPlanBriefText(account), paymentCapabilityBriefText(account)].filter(Boolean);
}
function gcashCoreInfoParts(account) {
  const flow = gcashFlowInfo(account);
  const qr = flow.qr || null;
  const credentialText = account?.sessionAvailable ? '登录态：可用' : '登录态：不可用';
  const refreshCount = Number(qr?.refreshCount || 0);
  const refreshText = refreshCount > 0 ? `刷新：${refreshCount}次` : '';
  const expiryText = flow.expiry ? `过期：${flow.expiry}` : '';
  return [
    `提炼：${flow.refineLabel}`,
    `监控：${flow.monitorLabel}`,
    credentialText,
    refreshText,
    expiryText,
  ].filter(Boolean);
}
function registrationRepairDiagnostic(task, account, summary) {
  const code = String(task?.error?.code || '').trim().toUpperCase();
  const message = String(task?.error?.message || summary?.fullDetail || summary?.detail || '').trim();
  if (code === 'FREEPP_EMAIL_ALREADY_REGISTERED') return { label: '邮箱已注册', message };
  if (code === 'ICMAIL_PUBLIC_HTTP_ERROR') return { label: '收件箱已失效', message };
  if (code === 'ICLOUD_SHEEX_HTTP_ERROR') return { label: '收件箱接口失效', message };
  if (['MAILBOX_PROVIDER_ERROR', 'MAILBOX_POLL_FAILED'].includes(code)) return { label: '邮箱读取失败', message };
  if (code === 'MAILBOX_CODE_TIMEOUT') return { label: '验证码接收超时', message };
  if (code === 'PROXY_GEO_CHECK_FAILED') return { label: '代理地区检查失败', message };
  if (code === 'PROXY_GEO_TIMEOUT') return { label: '代理地区检查超时', message };
  if (/SessionClosed|sidecar exited/iu.test(message)) return { label: '协议会话异常', message };
  if (code === 'FREEPP_REGISTRATION_FAILED' && /returned no result/iu.test(message)) {
    return { label: '注册协议未返回结果', message };
  }
  if (code === 'REGISTRATION_POST_STEPS_INCOMPLETE') return { label: '注册后设置未完成', message };
  if (code === 'CREDENTIAL_REPAIR_LOGIN_FAILED') return { label: '账号重新登录失败', message };
  if (code === 'CREDENTIAL_REPAIR_INCOMPLETE') return { label: '凭据修复结果不完整', message };
  if (code.startsWith('CREDENTIAL_REPAIR_')) return { label: '凭据修复失败', message };
  if (!account?.sessionAvailable) return { label: '注册未取得登录态', message: message || '注册流程未生成可用 session' };
  if (String(account?.passwordStatus || '').toLowerCase() !== 'has_password') {
    return { label: '密码设置未完成', message: message || '账号已有登录态，但密码设置状态不完整' };
  }
  if (String(account?.totpStatus || '').toLowerCase() !== 'enabled') {
    return { label: '2FA 设置未完成', message: message || '账号已有登录态，但 2FA 设置状态不完整' };
  }
  if (!account?.accessTokenAvailable) return { label: '访问令牌缺失', message: message || '账号未保存可用访问令牌' };
  return { label: '注册任务失败', message: message || code || '注册任务失败' };
}

function accountRowDiagnostics(entry, task, account, mailStage, summary) {
  if (mailStage === 'gcash') return [];
  const items = [];
  const add = (label, message, brief = label) => {
    const text = sanitizeStatusText(message || '');
    items.push({ label, brief, message: text || brief });
  };
  if (mailStage === 'repair') {
    const repair = registrationRepairDiagnostic(task, account, summary);
    add(repair.label, repair.message);
  }
  if (entry?.mailComReleaseStatus === 'waiting_session') {
    add('等待主邮箱会话解绑', entry.mailComReleaseError || '打开对应主邮箱会话后会自动重试');
  }
  if (entry?.mailComReleaseStatus === 'failed') {
    add('解绑失败', entry.mailComReleaseError || '请稍后重测资格重试');
  }
  if (account?.refiningJob?.status === 'error' && mailStage !== 'gcash') {
    add('提炼失败', account.refiningJob.error || account.refiningJob.message || '提炼任务失败');
  }
  const paymentError = paymentErrorText(account?.payment?.error || '');
  if (mailStage === 'unpaid' && account?.payment?.status === 'failed') {
    add('支付失败', paymentError || '支付任务失败');
  }
  const phoneBindError = sanitizeStatusText(account?.phoneBindError?.message || '');
  if (mailStage === 'paid' && account?.phoneBindStatus === 'failed') {
    add('接码失败', phoneBindError || '手机号绑定失败');
  }
  if (!items.length && summary?.status === 'failed') {
    add('任务失败', summary.fullDetail || summary.detail || task?.error?.message || '任务失败');
  }
  return items;
}
function mailboxVerificationText(account, { detail = false } = {}) {
  const repairability = account?.mailboxRepairability || {};
  const status = String(repairability.status || '').toLowerCase();
  const checkedAt = repairability.checkedAt ? new Date(repairability.checkedAt).toLocaleString() : '';
  if (status === 'unreachable') {
    return detail
      ? `上次复检不可达${checkedAt ? `（${checkedAt}）` : ''}；五分钟后自动重试`
      : '上次复检不可达';
  }
  if (status === 'available') {
    return detail
      ? `上次结果已过期${checkedAt ? `（${checkedAt}）` : ''}；正在等待重新确认`
      : '等待可用性复检';
  }
  return detail ? '尚未完成首次收件入口验证' : '等待首次验证';
}

function accountRowActivityText(account, mailStage, summary, diagnostics = []) {
  const gcashText = mailStage === 'gcash' ? gcashQrStatusText(account) : '';
  if (gcashText) return gcashText;
  if (diagnostics.length) return diagnostics[0].label;
  if (summary?.otpCode) return `验证码 ${summary.otpCode}`;
  const phoneStatus = String(account?.phoneBindStatus || '').toLowerCase();
  if (mailStage === 'paid' && ['queued', 'retry_wait', 'rt_pending', 'starting', 'otp_required'].includes(phoneStatus)) {
    return phoneBindAutoStatusText(account);
  }
  const paymentStatus = String(account?.payment?.status || '').toLowerCase();
  if (['starting', 'running', 'awaiting_otp', 'awaiting_captcha'].includes(paymentStatus)) {
    return paymentStatusText(account);
  }
  const refiningStatus = String(account?.refiningJob?.status || '').toLowerCase();
  if (['pending', 'dispatching', 'queued', 'running', 'remote_unknown', 'remote_lost'].includes(refiningStatus)) {
    return refiningStatusText(account);
  }
  if (summary?.status && !['succeeded', 'idle'].includes(summary.status)) {
    return summary.step && summary.step !== 'completed' ? shortStatusText(summary.step, 40) : summary.status;
  }
  return '';
}

function taskEventResultText(event) {
  const result = event?.result;
  if (!result || typeof result !== 'object') return '';
  const trial = result.trialEligibility;
  return trial?.status ? ` · 资格：${trialEligibilityText(trial.status)}` : '';
}
function taskEventMessageText(event) {
  const message = typeof event?.message === 'string' ? event.message.trim() : '';
  if (!message) return '';
  return ` · ${shortStatusText(message, 220)}`;
}

function miniAction(label, { danger = false, disabled = false, title = '', onClick } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = danger ? 'danger-mini' : 'primary-mini';
  button.disabled = Boolean(disabled);
  if (title) button.title = title;
  if (onClick) {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick(event);
    });
  }
  return button;
}

function workflowActionButtons(entry, account, mailStage, registrationView, busy = {}) {
  mailStage = visibleWorkflowStage(mailStage);
  const key = normalizeEmailKey(entry?.email);
  const sourceKind = registrationSourceKind(entry, account);
  const hasAt = Boolean(account?.accessTokenAvailable);
  const deleteLabel = sourceKind === 'mail' && ['preparing', 'registering'].includes(mailStage) ? '删除并解绑' : '删除';
  const deleteButton = () => miniAction(deleteLabel, {
    danger: true,
    disabled: !entry?.id && !entry?.email,
    onClick: () => deleteWorkflowEmail(entry),
  });
  const registerButton = () => {
    const action = registrationViewAction(registrationView);
    const registeredForRepair = registrationAssetStatus(entry, account, registrationView);
    const actionLabel = mailStage === 'repair'
      ? (registeredForRepair ? '修复凭据' : '重试注册')
      : '注册';
    return miniAction(actionLabel, {
      disabled: busy.isTaskStarting || !action.enabled,
      title: action.enabled ? '' : action.label,
      onClick: () => registeredForRepair
        ? repairCredentialsForEmail(entry)
        : retryOrStartRegistrationForEmail(entry, registrationView),
    });
  };
  const copyAtButton = () => miniAction('复制 AT', {
    disabled: !hasAt,
    title: hasAt ? '' : '该账号暂无已保存 AT',
    onClick: () => copyAccessTokenForEmail(entry),
  });
  const copyAccountButton = () => {
    if (credentialExportUnavailableReason(account)) return null;
    let preparedResult = null;
    const button = miniAction('复制账号', {
      onClick: () => {
        const current = preparedResult;
        preparedResult = null;
        copyCredentialExportForEmail(entry, current);
      },
    });
    button.addEventListener('pointerdown', () => {
      preparedResult = fetchCredentialExport(entry.email);
      preparedResult.catch(() => {});
    });
    return button;
  };
  const copyArtifactButton = () => {
    const artifact = paymentArtifactInfo(account);
    const value = artifact.value || '';
    return miniAction(artifact.type === 'BA' ? '复制 BA' : '复制产物', {
      disabled: !value,
      title: value || '暂无提炼产物',
      onClick: async () => {
        await copyTextToClipboard(value);
        $('startFeedback').textContent = `已复制提炼产物：${entry.email}`;
      },
    });
  };
  const buttons = [];
  if (mailStage === 'preparing') buttons.push(registerButton(), copyAccountButton(), deleteButton());
  else if (mailStage === 'registering') buttons.push(copyAccountButton(), deleteButton());
  else if (mailStage === 'repair') buttons.push(registerButton(), copyAccountButton(), deleteButton());
  else if (['repair_verification', 'unrepairable'].includes(mailStage)) buttons.push(copyAccountButton(), deleteButton());
  else if (['eligibility', 'discarded'].includes(mailStage)) buttons.push(
    miniAction(mailStage === 'discarded' ? '二次检测' : '重测', {
      disabled: !protocolEligibilityReady(account) || account?.eligibilityStatus === 'checking',
      onClick: () => checkEligibilityForEmail(entry),
    }),
    copyAtButton(),
    copyAccountButton(),
    deleteButton(),
  );
  else if (mailStage === 'payment_method') buttons.push(
    miniAction('重测', {
      disabled: state.activePaymentMethodProbeStarts.has(key) || ['queued', 'checking'].includes(String(account?.paymentCapabilities?.status || '').toLowerCase()),
      onClick: () => startPaymentMethodProbeForEmail(entry),
    }),
    copyAtButton(),
    copyAccountButton(),
    deleteButton(),
  );
  else if (mailStage === 'refining') buttons.push(
    miniAction(['error', 'cancelled', 'remote_unknown', 'remote_lost'].includes(String(account?.refiningJob?.status || '').toLowerCase()) ? '重试' : '开始', {
      disabled: busy.isRefiningStarting || ['dispatching', 'queued', 'running'].includes(String(account?.refiningJob?.status || '').toLowerCase()),
      onClick: () => startRefiningForEmail(entry),
    }),
    copyAtButton(),
    copyAccountButton(),
    deleteButton(),
  );
  else if (mailStage === 'unpaid') buttons.push(
    miniAction('标记已支付', { onClick: () => setMailComStageForEmail(entry, 'paid') }),
    copyArtifactButton(),
    copyAccountButton(),
  );
  else if (mailStage === 'paid') buttons.push(
    hasCapability('phoneBind') ? miniAction(state.activePhoneBindStarts.has(key) ? '接码中' : '接码', {
      disabled: state.activePhoneBindStarts.has(key) || !account?.sessionAvailable,
      onClick: () => startPhoneBindForEmail(entry, { forceAutomatic: true }),
    }) : null,
    copyAccountButton(),
    miniAction('标记已售', { onClick: () => setMailComStageForEmail(entry, 'sold') }),
  );
  else if (mailStage === 'completed') buttons.push(
    !hasCapability('payment') ? miniAction('复核资格', {
      disabled: !protocolEligibilityReady(account) || account?.eligibilityStatus === 'checking',
      onClick: () => checkEligibilityForEmail(entry),
    }) : null,
    !hasCapability('payment') ? copyAtButton() : null,
    copyAccountButton(),
    hasCapability('payment') ? miniAction('标记已售', { onClick: () => setMailComStageForEmail(entry, 'sold') }) : null,
  );
  else if (mailStage === 'sold') buttons.push(copyAccountButton());
  return buttons.filter(Boolean);
}

function workflowIdentityMeta(entry, task, account, mailStage, summary) {
  if (mailStage === 'preparing' && registrationSourceKind(entry, account) === 'mail') {
    const main = mailComAccountForEmail(entry.email)?.email || task?.mainMailboxEmail || '';
    return main ? `主邮箱：${main}` : '主邮箱：未绑定';
  }
  if (summary.taskId && ['registering', 'repair'].includes(mailStage)) return `任务：${summary.taskId}`;
  if (mailStage === 'repair') return `失败阶段：${repairFailureStage(entry, account, registrationViewForEmail(entry.email))}`;
  return mailboxMeta(entry);
}

function workflowStatusText(entry, task, account, mailStage, summary, registrationView, rowDiagnostics = []) {
  if (mailStage === 'registering') return registrationViewActivity(registrationView) || accountRowActivityText(account, mailStage, summary, []);
  if (mailStage === 'repair') return registrationViewActivity(registrationView) || rowDiagnostics[0]?.label || repairFailureStage(entry, account, registrationView);
  if (mailStage === 'repair_verification') return mailboxVerificationText(account);
  if (mailStage === 'unrepairable') return '收件箱已失效';
  if (mailStage === 'eligibility') return eligibilityText(account).replace(/^资格：/u, '') || '待重测';
  if (mailStage === 'payment_method') return paymentCapabilityBriefText(account).replace(/^支付方式：/u, '') || '待重测';
  if (mailStage === 'refining') return refiningStatusText(account) || '待提炼';
  if (mailStage === 'unpaid') return paymentArtifactInfo(account).type || '待支付';
  if (mailStage === 'paid') return phoneBindAutoStatusText(account);
  return mailComStageLabel(mailStage);
}

function workflowDetailText(entry, task, account, mailStage, summary, registrationView, rowDiagnostics) {
  if (mailStage === 'preparing') {
    const main = mailComAccountForEmail(entry.email)?.email || task?.mainMailboxEmail || '';
    return registrationSourceKind(entry, account) === 'mail'
      ? `分裂邮箱待注册${main ? ` · 主邮箱 ${main}` : ''}`
      : (entry.mailboxUrl || mailboxMeta(entry));
  }
  if (mailStage === 'registering') {
    const running = ['running', 'waiting_mail'].includes(String(registrationView?.status || summary.status || '').toLowerCase());
    const startedAt = running ? Date.parse(task?.startedAt || registrationView?.startedAt || '') : Number.NaN;
    const elapsed = Number.isFinite(startedAt) ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0;
    return `${registrationViewActivity(registrationView) || summary.detail || '注册中'}${elapsed ? ` · 运行 ${elapsed}s` : ''}`;
  }
  if (mailStage === 'repair') return summary.fullDetail || summary.detail || rowDiagnostics[0]?.message || '等待自动调度';
  if (mailStage === 'repair_verification') return mailboxVerificationText(account, { detail: true });
  if (mailStage === 'unrepairable') return '收件入口已确认失效；该账号不会进入注册或凭据修复队列';
  if (mailStage === 'eligibility') return eligibilityText(account);
  if (mailStage === 'payment_method') return paymentCapabilityText(account) || '支付方式待重测';
  if (mailStage === 'refining') return [paymentMethodLabel(account), paymentCheckoutType(account), refiningStatusText(account)].filter(Boolean).join(' · ');
  if (mailStage === 'unpaid') {
    const artifact = paymentArtifactInfo(account);
    return [paymentMethodLabel(account), artifact.type, artifact.value].filter(Boolean).join(' · ');
  }
  if (['paid', 'completed', 'sold'].includes(mailStage)) {
    return [paymentMethodLabel(account), paymentArtifactInfo(account).type].filter(Boolean).join(' · ');
  }
  return registrationViewActivity(registrationView) || accountCoreInfoParts(account).join(' · ') || '等待状态更新';
}

function emailStatusRow(entry, task, account, registrationView = null) {
  registrationView = registrationView || registrationViewForEmail(entry?.email);
  const summary = taskSummary(task, registrationView);
  const mailStage = accountWorkflowStage(entry, task, account, registrationView);
  const card = document.createElement('div');
  card.className = 'email-status-card';
  if (summary.taskId && mailStage !== 'preparing') {
    card.classList.add('clickable');
    let rowPressStartedAt = 0;
    const isFastRowClick = () => !rowPressStartedAt || performance.now() - rowPressStartedAt <= 300;
    const toggleExpanded = () => {
      if (state.expandedTaskIds.has(summary.taskId)) state.expandedTaskIds.delete(summary.taskId);
      else {
        state.expandedTaskIds.add(summary.taskId);
        if (task.eventsTruncated) loadTaskDetails(summary.taskId).catch((error) => {
          $('startFeedback').textContent = `任务详情加载失败：${error.message}`;
        });
      }
      renderEmailRunStatus();
    };
    card.addEventListener('pointerdown', () => { rowPressStartedAt = performance.now(); });
    card.addEventListener('click', () => {
      if (!isFastRowClick()) return;
      toggleExpanded();
    });
    card.addEventListener('dblclick', () => {
      if (!isFastRowClick()) return;
      toggleExpanded();
    });
  }
  const key = normalizeEmailKey(entry.email);
  const node = document.createElement('div');
  node.className = 'email-status-row';
  node.dataset.email = key;
  const selector = document.createElement('label');
  selector.className = 'at-select-wrap';
  selector.title = '选择后可批量操作当前列表';
  const selectAt = document.createElement('input');
  selectAt.type = 'checkbox';
  selectAt.className = 'at-select';
  selectAt.checked = state.selectedWorkflowEmails.has(key);
  selectAt.disabled = false;
  selectAt.addEventListener('click', (event) => event.stopPropagation());
  selectAt.addEventListener('change', () => {
    if (selectAt.checked) state.selectedWorkflowEmails.add(key);
    else state.selectedWorkflowEmails.delete(key);
    updateCopySelectedAtButtons();
    updateSelectedWorkflowAtLiveButton();
  });
  selector.append(selectAt);
  const identity = document.createElement('div');
  identity.className = 'email-status-identity';
  const email = document.createElement('strong');
  email.textContent = entry.email;
  const meta = document.createElement('code');
  meta.textContent = workflowIdentityMeta(entry, task, account, mailStage, summary);
  meta.className = 'mailbox-url';
  identity.append(email, meta);
  const isTaskStarting = state.activeTaskStarts.has(key);
  const isRefiningStarting = state.activeRefiningStarts.has(key);
  const isAccountStatusChecking = state.activeAccountStatusChecks.has(key);
  const rowFeedback = mailRunAccountFeedback(key);
  const rowDiagnostics = accountRowDiagnostics(entry, task, account, mailStage, summary);
  const rowBusy = isTaskStarting || isRefiningStarting || isAccountStatusChecking;
  node.dataset.status = rowDiagnostics.length ? 'failed' : (rowBusy ? 'running' : summary.status);
  const rowActivity = isTaskStarting
    ? '任务创建中…'
    : isRefiningStarting
      ? '正在加入提炼…'
      : isAccountStatusChecking
        ? '账号状态检测中…'
        : rowFeedback || workflowStatusText(entry, task, account, mailStage, summary, registrationView, rowDiagnostics);
  const status = document.createElement('div');
  status.className = 'email-status-state';
  const badge = document.createElement('span');
  badge.className = 'status-badge';
  badge.textContent = mailComStageLabel(mailStage);
  const step = document.createElement('code');
  step.textContent = rowActivity;
  if (!rowActivity) step.hidden = true;
  status.append(badge, step);
  const detail = document.createElement('div');
  detail.className = 'email-status-detail';
  const eligibilitySummary = eligibilityText(account);
  const passwordSummary = passwordStatusText(account);
  const refiningSummary = refiningStatusText(account);
  const paymentSummary = paymentStatusText(account);
  const coreParts = accountCoreInfoParts(account);
  detail.textContent = workflowDetailText(entry, task, account, mailStage, summary, registrationView, rowDiagnostics);
  if (summary.otpCode) detail.classList.add('has-code');
  if (rowDiagnostics.length) {
    detail.dataset.status = 'failed';
  }
  const titleParts = [
    ...coreParts,
    passwordSummary,
    eligibilitySummary,
    refiningSummary,
    paymentSummary,
  ];
  detail.title = titleParts.filter(Boolean).join(' · ');
  const actions = document.createElement('div');
  actions.className = 'item-actions';
  actions.append(...workflowActionButtons(entry, account, mailStage, registrationView, {
    isTaskStarting,
    isRefiningStarting,
  }));
  node.append(selector, identity, status, detail, actions);
  card.append(node);
  if (mailStage !== 'preparing' && summary.taskId && state.expandedTaskIds.has(summary.taskId)) {
    const log = document.createElement('ol');
    log.className = 'email-status-events';
    log.dataset.taskId = summary.taskId;
    log.addEventListener('click', (event) => event.stopPropagation());
    log.addEventListener('scroll', () => {
      state.eventScroll.set(summary.taskId, {
        scrollTop: log.scrollTop,
        atBottom: isScrolledToBottom(log),
      });
    });
    for (const diagnostic of rowDiagnostics) {
      const li = document.createElement('li');
      li.textContent = `当前状态 · ${diagnostic.label}：${shortStatusText(diagnostic.message, 600)}`;
      log.append(li);
    }
    for (const event of (task.events || [])) {
      const li = document.createElement('li');
      const codeText = event.otpCode ? ` · 验证码：${event.otpCode}` : '';
      const mailboxText = event.mailbox?.receivedAt ? ` · 邮件时间：${event.mailbox.receivedAt}` : '';
      const resultText = taskEventResultText(event);
      const messageText = taskEventMessageText(event);
      const errorText = event.error ? ` · ${event.error.code}: ${shortStatusText(event.error.message, 220)}` : '';
      li.textContent = `${event.type || 'event'}${codeText}${mailboxText}${resultText}${messageText}${errorText}`;
      log.append(li);
    }
    card.append(log);
  }
  return card;
}
function isScrolledToBottom(node) {
  return node.scrollTop + node.clientHeight >= node.scrollHeight - 8;
}
function captureEventScroll() {
  for (const node of document.querySelectorAll('.email-status-events[data-task-id]')) {
    state.eventScroll.set(node.dataset.taskId, {
      scrollTop: node.scrollTop,
      atBottom: isScrolledToBottom(node),
    });
  }
}
function restoreEventScroll() {
  for (const node of document.querySelectorAll('.email-status-events[data-task-id]')) {
    const saved = state.eventScroll.get(node.dataset.taskId);
    if (!saved || saved.atBottom) {
      node.scrollTop = node.scrollHeight;
    } else {
      node.scrollTop = saved.scrollTop;
    }
  }
}

function workflowSearchMatches(row, query) {
  const text = String(query || '').trim().toLowerCase();
  if (!text) return true;
  const account = row.account || {};
  const haystack = [
    row.entry?.email,
    paymentMethodLabel(account),
    paymentCheckoutType(account),
    paymentArtifactInfo(account).type,
    paymentArtifactInfo(account).value,
  ].join(' ').toLowerCase();
  return haystack.includes(text);
}

function visibleRowsForWorkflow(rowsForStage) {
  let rows = Array.isArray(rowsForStage) ? rowsForStage : [];
  if (state.activeMailWorkflowStage === 'refining') {
    rows = rows.filter((row) => workflowSearchMatches(row, state.mailWorkflowRefiningQuery));
  }
  if (state.activeMailWorkflowStage === 'sold') {
    rows = rows.filter((row) => soldSubstage(row.account, row.entry) === state.soldWorkflowSubstage);
  }
  return rows;
}

function renderWorkflowRows(rows, target) {
  if (!DATE_GROUPED_MAIL_STAGES.has(state.activeMailWorkflowStage)) {
    return rows.map((row) => emailStatusRow(row.entry, row.task, row.account, row.registrationView));
  }
  const groups = new Map();
  for (const row of rows) {
    const key = registrationDateKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const nodes = [];
  const sortedGroups = [...groups.entries()].sort(([left], [right]) => String(right).localeCompare(String(left)));
  for (const [date, groupRows] of sortedGroups) {
    const details = document.createElement('details');
    details.className = 'workflow-date-group';
    details.open = nodes.length === 0;
    const summary = document.createElement('summary');
    summary.textContent = `${date}（${groupRows.length}）`;
    details.append(summary, ...groupRows.map((row) => emailStatusRow(row.entry, row.task, row.account, row.registrationView)));
    nodes.push(details);
  }
  return nodes.length ? nodes : [item({ title: `${target.emptyTitle}暂无日期分组`, meta: target.emptyMeta })];
}

function renderEmailRunStatus() {
  captureEventScroll();
  const labels = { ic: 'IC邮箱', domain: '域名邮箱', mail_com: 'mail邮箱' };
  for (const button of document.querySelectorAll('[data-run-category]')) {
    const category = button.dataset.runCategory;
    const count = state.emails.filter((entry) => runEmailCategory(entry) === category).length;
    button.classList.toggle('active', category === state.activeRunCategory);
    button.textContent = `${labels[category] || '邮箱'} ${count}`;
  }
  for (const panel of document.querySelectorAll('[data-run-panel]')) {
    panel.hidden = panel.dataset.runPanel !== state.activeRunCategory;
  }
  const tasks = taskById();
  const accounts = accountById();
  const registrationViews = state.registrationView?.byEmail || {};
  const liveEmails = new Set(state.emails.map((entry) => String(entry.email || '').toLowerCase()).filter(Boolean));
  for (const email of [...state.selectedWorkflowEmails]) {
    if (!liveEmails.has(String(email || '').toLowerCase())) state.selectedWorkflowEmails.delete(email);
  }
  const displayOrder = syncMailRunDisplayOrder(state.emails);
  const rows = {
    ic: emptyWorkflowRows(),
    domain: emptyWorkflowRows(),
    mail_com: emptyWorkflowRows(),
  };
  for (const entry of state.emails) {
    const email = String(entry.email || '').toLowerCase();
    const category = runEmailCategory(entry);
    const task = entry.generatedTaskId ? tasks.get(entry.generatedTaskId) : null;
    const accountId = entry.accountId || task?.accountId || null;
    const account = accountId ? accounts.get(accountId) : null;
    const candidateRegistrationView = registrationViews[email] || null;
    const registrationView = candidateRegistrationView;
    const rowData = { entry, task, account, registrationView };
    const stage = accountWorkflowStage(entry, task, account, registrationView);
    if (!MAIL_WORKFLOW_STAGES.includes(stage)) continue;
    const categoryRows = rows[category] || rows.ic;
    categoryRows[stage].push(rowData);
  }
  const stageLabels = { preparing: '准备阶段', registering: '注册中', repair: '待修复', repair_verification: '收件箱待验证', unrepairable: '不可修复', eligibility: '测资格', discarded: '无资格', payment_method: '支付方式待定', refining: '提炼', unpaid: '未支付', paid: '已支付', completed: '已完成', sold: '已售' };
  const activeCategory = ['ic', 'domain', 'mail_com'].includes(state.activeRunCategory) ? state.activeRunCategory : 'ic';
  const activeCategoryRows = rows[activeCategory] || rows.ic;
  for (const button of document.querySelectorAll('[data-mail-workflow-stage]')) {
    const stage = button.dataset.mailWorkflowStage;
    const stageRows = activeCategoryRows[stage];
    const stageCount = stageRows?.length || 0;
    button.classList.toggle('active', stage === state.activeMailWorkflowStage);
    button.textContent = `${stageLabels[stage] || stage} ${stageCount}`;
  }
  const rowsForCategory = (category) => {
    const categoryRows = rows[category] || rows.ic;
    return categoryRows[state.activeMailWorkflowStage] || [];
  };
  const activeRows = stableMailRunRows(rowsForCategory(activeCategory), displayOrder);
  state.activeMailWorkflowRows = activeRows;
  const visibleActiveRows = visibleRowsForWorkflow(activeRows);
  state.visibleMailWorkflowRows = visibleActiveRows;
  for (const email of [...state.selectedWorkflowEmails]) {
    if (!visibleActiveRows.some((row) => normalizeEmailKey(row.entry?.email) === email)) {
      state.selectedWorkflowEmails.delete(email);
    }
  }
  const refiningFilter = $('mailWorkflowRefiningFilter');
  if (refiningFilter) {
    refiningFilter.hidden = state.activeMailWorkflowStage !== 'refining';
    if (document.activeElement !== refiningFilter) refiningFilter.value = state.mailWorkflowRefiningQuery || '';
  }
  const soldTabs = $('mailWorkflowSoldTabs');
  if (soldTabs) soldTabs.hidden = state.activeMailWorkflowStage !== 'sold';
  for (const button of document.querySelectorAll('[data-sold-substage]')) {
    button.classList.toggle('active', button.dataset.soldSubstage === state.soldWorkflowSubstage);
    const count = activeRows.filter((row) => soldSubstage(row.account, row.entry) === button.dataset.soldSubstage).length;
    button.textContent = `${button.dataset.soldSubstage === 'sms' ? '已接码' : '未接码'} ${count}`;
  }
  const selectAll = $('selectVisibleWorkflowRows');
  if (selectAll) {
    const selectable = visibleActiveRows.map((row) => normalizeEmailKey(row.entry?.email)).filter(Boolean);
    const selectedCount = selectable.filter((email) => state.selectedWorkflowEmails.has(email)).length;
    selectAll.checked = selectable.length > 0 && selectedCount === selectable.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < selectable.length;
    selectAll.disabled = selectable.length === 0;
  }
  updateSelectedWorkflowAtLiveButton();
  updateWorkflowStageActionButton();
  const activeStageLabel = stageLabels[state.activeMailWorkflowStage] || state.activeMailWorkflowStage;
  const runLists = {
    ic: { id: 'icRunEmailList', emptyTitle: 'IC邮箱', emptyMeta: '切换阶段后会显示对应状态的 IC 账号' },
    domain: { id: 'domainRunEmailList', emptyTitle: '域名邮箱', emptyMeta: '切换阶段后会显示对应状态的域名账号' },
    mail_com: { id: 'mailRunEmailList', emptyTitle: 'mail邮箱', emptyMeta: '状态变化后会自动进入对应分类' },
  };
  for (const [category, target] of Object.entries(runLists)) {
    const list = $(target.id);
    if (!list) continue;
    if (category !== activeCategory) {
      list.replaceChildren();
      continue;
    }
    const sourceRows = visibleRowsForWorkflow(stableMailRunRows(rowsForCategory(category), displayOrder));
    list.replaceChildren(...(sourceRows.length
      ? renderWorkflowRows(sourceRows, target)
      : [item({ title: `${activeStageLabel}分类暂无${target.emptyTitle}`, meta: target.emptyMeta })]));
  }
  updateCopySelectedAtButtons();
  restoreEventScroll();
}
function poolLabel(pool) {
  const countries = pool.countries?.length ? ` · ${pool.countries.slice(0, 6).join('/')}` : '';
  const bad = pool.badCount ? ` · 冷却 ${pool.badCount}` : '';
  return `${pool.name} · ${pool.count} 条${countries}${bad}`;
}
function renderProxySelect(select, category) {
  const pools = state.proxyCatalog?.[category] || [];
  const current = selectedProxyPool(category);
  renderProxySelectOptions(select, pools, current);
}

function renderConfiguredProxySelect(select, category, configuredPoolId = '') {
  const pools = state.proxyCatalog?.[category] || [];
  const configured = String(configuredPoolId || '').trim();
  const current = configured && pools.some((pool) => pool.id === configured)
    ? configured
    : DIRECT_PROXY_VALUE;
  renderProxySelectOptions(select, pools, current);
}

function renderProxySelectOptions(select, pools, current) {
  const direct = document.createElement('option');
  direct.value = DIRECT_PROXY_VALUE;
  direct.textContent = '直连';
  direct.selected = current === DIRECT_PROXY_VALUE;
  select.replaceChildren(direct, ...pools.map((pool) => {
    const option = document.createElement('option');
    option.value = pool.id;
    option.textContent = poolLabel(pool);
    option.selected = pool.id === current;
    return option;
  }));
}
function renderPoolManagerSelect(select, category) {
  const pools = state.proxyCatalog?.[category] || [];
  const saved = state.selectedProxyPools?.[category];
  const current = saved && pools.some((pool) => pool.id === saved)
    ? saved
    : pools[0]?.id || '';
  select.replaceChildren(...pools.map((pool) => {
    const option = document.createElement('option');
    option.value = pool.id;
    option.textContent = poolLabel(pool);
    option.selected = pool.id === current;
    return option;
  }));
  select.value = current;
  return current;
}
function proxyCardPoolId(card, category) {
  const value = card.querySelector('.pool-select')?.value || '';
  const pools = state.proxyCatalog?.[category] || [];
  if (value && pools.some((pool) => pool.id === value)) return value;
  return pools[0]?.id || '';
}
function setProxyFeedback(card, message) {
  const text = String(message || '');
  const feedback = card.querySelector('.proxy-feedback');
  if (feedback) feedback.textContent = text;
  $('startFeedback').textContent = text;
}
function renderRuntimeControls() {
  renderProxySelect($('mainProxyPoolSelect'), 'main');
  renderExecutionTypeSelect();
  renderEntryBranchSelect();
  renderBrowserEngineSelect();
}

function renderProxyPools() {
  renderRuntimeControls();
  for (const card of document.querySelectorAll('[data-pool]')) {
    const category = card.dataset.pool;
    const select = card.querySelector('.pool-select');
    const currentId = renderPoolManagerSelect(select, category);
    const current = (state.proxyCatalog?.[category] || []).find((pool) => pool.id === currentId);
    const count = Number(current?.count || 0);
    card.dataset.empty = current && count > 0 ? 'false' : 'true';
    card.querySelector('.delete-pool').disabled = !current;
    card.querySelector('.mini-list').replaceChildren(item({
      title: current ? `${current.name} · ${count} 条` : '没有代理池',
      meta: current?.countries?.length ? current.countries.join(' / ') : (current ? '无国家标记' : '先新建池'),
    }));
  }
}
function renderBrowserEngineSelect() {
  const select = $('browserEngineSelect');
  if (!select) return;
  const serviceEngine = state.config?.browser?.engine || '';
  const selected = selectedBrowserEngine();
  const usesBrowser = Boolean(selectedExecutionTypeItem()?.usesFingerprintBrowser);
  const field = $('browserEngineField') || select.closest('label');
  if (field) field.hidden = !usesBrowser || !hasCapability('browserRegistration');
  select.replaceChildren(...[
    { id: '', key: '', label: `服务默认${serviceEngine ? `（${browserEngineLabel(serviceEngine)}）` : ''}` },
    ...executionCatalog().fingerprintBrowsers,
  ].map((engine) => {
    const option = document.createElement('option');
    option.value = engine.id;
    option.dataset.key = engine.key;
    option.textContent = engine.label;
    option.selected = engine.key === selected;
    return option;
  }));
  select.disabled = !usesBrowser || !hasCapability('browserRegistration');
}

function renderExecutionTypeSelect() {
  const select = $('executionTypeSelect');
  if (!select) return;
  const selected = selectedExecutionType();
  select.replaceChildren(...executionCatalog().types.map((type) => {
    const option = document.createElement('option');
    option.value = type.id;
    option.dataset.key = type.key;
    option.textContent = type.label;
    option.selected = type.key === selected;
    return option;
  }));
}

function renderEntryBranchSelect() {
  const select = $('entryBranchSelect');
  if (!select) return;
  const type = selectedExecutionType();
  const selected = selectedEntryBranch();
  const implementations = implementationsForType(type);
  const field = $('entryBranchField') || select.closest('label');
  if (field) field.hidden = implementations.length === 1;
  if (!implementations.length) {
    if (field) field.hidden = false;
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '尚未配置实现';
    select.replaceChildren(option);
    select.disabled = true;
    renderBrowserEngineSelect();
    return;
  }
  select.disabled = false;
  select.replaceChildren(...implementations.map((branch) => {
    const option = document.createElement('option');
    option.value = branch.id;
    option.dataset.key = branch.key;
    option.textContent = branch.label;
    option.selected = branch.key === selected;
    return option;
  }));
  renderBrowserEngineSelect();
}
function renderTasks() {
  $('taskCountValue').textContent = String(state.tasks.length);
}

const AUTO_REFRESH_INTERVAL_MS = 5000;
const USER_OPERATION_REFRESH_PAUSE_MS = 3500;
const EDITING_REFRESH_PAUSE_MS = 8000;
const FRONTEND_VERSION_CHECK_MS = 10000;
const FRONTEND_ASSET_URL = document.querySelector('script[src*="/js/app.js"]')?.getAttribute('src') || '/js/app.js';

function suspendAutoRefresh(ms = USER_OPERATION_REFRESH_PAUSE_MS) {
  state.autoRefreshSuspendedUntil = Math.max(Number(state.autoRefreshSuspendedUntil || 0), Date.now() + ms);
}

function markSettingsDraftDirty(flag) {
  state[flag] = true;
  suspendAutoRefresh(EDITING_REFRESH_PAUSE_MS);
}

function bindSettingsDraftDirty(ids, flag) {
  for (const id of ids) {
    const element = $(id);
    if (!element) continue;
    element.addEventListener('input', () => markSettingsDraftDirty(flag));
    element.addEventListener('change', () => markSettingsDraftDirty(flag));
  }
}

function activeElementIsEditing() {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  const tag = String(active.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || active.isContentEditable;
}

function hasActiveUserOperation() {
  return activeElementIsEditing()
    || Date.now() < Number(state.autoRefreshSuspendedUntil || 0)
    || state.activeTaskStarts.size > 0
    || state.activePaymentStarts.size > 0
    || state.activePhoneBindStarts.size > 0
    || state.activeRefreshTokenStarts.size > 0
    || state.activeSessionCookieRenewals.size > 0
    || state.bulkCopyingAccessTokens
    || state.bulkCopyingCredentials
    || state.bulkCheckingAccessTokens
    || state.bulkCopyingRefreshTokens
    || state.bulkMovingCompletedToSold;
}

async function checkFrontendVersion() {
  try {
    const response = await fetch(FRONTEND_ASSET_URL, { method: 'HEAD', cache: 'no-store' });
    const version = `${response.headers.get('etag') || ''}|${response.headers.get('last-modified') || ''}|${response.headers.get('content-length') || ''}`;
    if (!version.replace(/\|/g, '').trim()) return;
    if (!state.frontendAssetVersion) {
      state.frontendAssetVersion = version;
      return;
    }
    if (version !== state.frontendAssetVersion && !state.frontendUpdateAvailable) {
      state.frontendUpdateAvailable = true;
      if (!hasActiveUserOperation()) {
        window.location.reload();
        return;
      }
      const target = $('runtimeStatus') || $('startFeedback');
      if (target) target.textContent = '前端已更新，空闲时会自动刷新页面。';
    }
  } catch {}
}

async function autoRefresh() {
  if (hasActiveUserOperation()) return;
  if (state.frontendUpdateAvailable) {
    window.location.reload();
    return;
  }
  await refresh({ silent: true, lightweight: true });
}

async function fetchBaseRuntimeState() {
  const [emails, accounts, refining, registrationView, pipelineConcurrency] = await Promise.all([
    api.get('/api/emails'),
    api.get('/api/accounts?summary=1&currentEmails=1'),
    hasCapability('refining') ? api.get('/api/refining') : Promise.resolve(null),
    api.get('/api/registration-view?currentEmails=1'),
    api.get('/api/pipeline-concurrency'),
  ]);
  state.emails = emails;
  state.accounts = accounts;
  state.refining = refining;
  state.registrationView = registrationView || { byEmail: {}, summary: {} };
  state.pipelineConcurrency = pipelineConcurrency;
}

async function fetchTaskState() {
  const previousTasks = new Map(state.tasks.map((task) => [task.id, task]));
  const taskSummaries = await api.get('/api/tasks?summary=1&latestByEmail=1&currentEmails=1');
  state.tasks = taskSummaries.map((task) => {
    const previous = previousTasks.get(task.id);
    if (state.expandedTaskIds.has(task.id) && previous && previous.eventsTruncated === false) {
      return { ...task, events: previous.events, eventsTruncated: false };
    }
    return task;
  });
}

async function fetchConfigState() {
  state.config = await api.get('/api/config');
  applyCapabilities();
  state.pipelineConcurrency = state.config.pipelineConcurrency || state.pipelineConcurrency;
  const preferences = state.config.preferences || {};
  if (preferences.proxyPools && typeof preferences.proxyPools === 'object') {
    state.selectedProxyPools = { ...state.selectedProxyPools, ...preferences.proxyPools };
    localStorage.setItem('selectedProxyPools', JSON.stringify(state.selectedProxyPools));
  }
  if (preferences.browserEngine) {
    state.selectedBrowserEngine = preferences.browserEngine;
    localStorage.setItem('selectedBrowserEngine', state.selectedBrowserEngine);
  }
  if (preferences.entryBranch) {
    state.selectedEntryBranch = preferences.entryBranch;
    localStorage.setItem('selectedEntryBranch', state.selectedEntryBranch);
  }
  const preferredType = executionTypeItem(preferences.executionType)
    || executionTypeItem(executionImplementationItem(preferences.entryBranch)?.type)
    || executionTypeItem(state.config?.registration?.executionType);
  if (preferredType) {
    state.selectedExecutionType = preferredType.key;
    localStorage.setItem('selectedExecutionType', state.selectedExecutionType);
  }
  state.registrationChangeEmailSettings = state.config.registration?.changeEmail || state.registrationChangeEmailSettings || null;
  const freshCfMailbox = state.config.mailbox?.cloudflareTempEmail || null;
  state.cfMailbox = state.cfMailboxDraftDirty && state.cfMailbox
    ? { ...freshCfMailbox, ...state.cfMailbox }
    : freshCfMailbox;
  $('runtimeStatus').textContent = `HTTP-only · ${state.config.collector?.mode || 'full'}`;
  $('transportValue').textContent = String(state.config.transport || 'http').toUpperCase();
  $('collectorValue').textContent = state.config.collector?.mode || 'full';
  $('browserValue').textContent = state.config.browserEnabled
    ? `已启用 · ${browserEngineLabel(state.config.browser?.engine)}`
    : '未启用';
}

async function fetchProxyState() {
  if (!hasCapability('proxies')) return;
  state.proxyCatalog = await api.get('/api/proxy-pools');
}

async function fetchPaymentState() {
  if (hasCapability('payment')) state.paymentSettings = await api.get('/api/payment/settings');
  if (hasCapability('paymentMethodProbe')) state.paymentMethodProbeSettings = await api.get('/api/payment-method-probe/settings');
}

async function fetchPhoneBindState() {
  if (!hasCapability('phoneBind') && !hasCapability('registration')) return;
  state.phoneBindSettings = await api.get('/api/phone-bind/settings');
}

async function fetchMailComState() {
  if (!hasCapability('mailbox')) return;
  state.mailComAccounts = await api.get('/api/mailbox/mail-com-split/accounts');
}

function reconcileLiveSelections() {
  const liveIds = new Set(state.emails.map((entry) => entry.id));
  for (const id of [...state.selectedEmailIds]) {
    if (!liveIds.has(id)) state.selectedEmailIds.delete(id);
  }
  const liveTaskIds = new Set(state.tasks.filter(isImportedTask).map((task) => task.id));
  for (const id of [...state.expandedTaskIds]) {
    if (!liveTaskIds.has(id)) state.expandedTaskIds.delete(id);
  }
}

async function ensureConfigState() {
  if (!state.config) await fetchConfigState();
}

const VIEW_REFRESHERS = {
  run: async () => {
    await Promise.all([
      ensureConfigState(),
      fetchProxyState(),
      fetchBaseRuntimeState(),
      fetchTaskState(),
      fetchMailComState(),
    ]);
  },
  mail: async () => {
    await Promise.all([
      fetchConfigState(),
      fetchMailComState(),
      fetchBaseRuntimeState(),
    ]);
  },
  refining: async () => {
    await fetchBaseRuntimeState();
  },
  payment: async () => {
    await Promise.all([
      fetchConfigState(),
      fetchProxyState(),
      fetchPaymentState(),
    ]);
  },
  'phone-bind': async () => {
    await Promise.all([
      fetchConfigState(),
      fetchProxyState(),
      fetchPhoneBindState(),
    ]);
  },
  proxies: async () => {
    await Promise.all([
      fetchConfigState(),
      fetchProxyState(),
    ]);
  },
};

const VIEW_RENDERERS = {
  run: () => {
    renderRuntimeControls();
    renderRegistrationChangeEmailSettings();
    if (!hasCapability('phoneBind')) renderPhoneBindSettings();
    renderTasks();
    renderEmailRunStatus();
    renderMailComSplitAccounts();
  },
  mail: () => {
    renderEmailInventory();
    renderMailComSplitConfig();
    renderMailComSplitAccounts();
  },
  refining: () => {
    renderRefining();
  },
  payment: () => {
    renderPaymentSettings();
    renderPaymentMethodProbeSettings();
  },
  'phone-bind': () => {
    renderPhoneBindSettings();
  },
  proxies: () => {
    renderProxyPools();
  },
};

function renderView(tab = state.activeTab) {
  tab = viewEnabled(tab) ? tab : 'run';
  const render = VIEW_RENDERERS[tab] || VIEW_RENDERERS.run;
  render();
}

async function refreshViewData(tab = state.activeTab) {
  await ensureConfigState();
  tab = viewEnabled(tab) ? tab : 'run';
  const sync = VIEW_REFRESHERS[tab] || VIEW_REFRESHERS.run;
  await sync();
  reconcileLiveSelections();
}

async function refreshAllData() {
  await fetchConfigState();
  await Promise.all([
    fetchProxyState(),
    fetchPaymentState(),
    fetchPhoneBindState(),
    fetchMailComState(),
    fetchBaseRuntimeState(),
    fetchTaskState(),
  ]);
  reconcileLiveSelections();
}

async function refresh({ silent = false, lightweight = true, all = false } = {}) {
  if (state.refreshing) {
    state.refreshQueued = true;
    return;
  }
  state.refreshing = true;
  const interactionRevision = state.userInteractionRevision;
  try {
    if (all || lightweight === false) {
      await refreshAllData();
    } else {
      await refreshViewData(state.activeTab);
    }
    const userStartedEditingDuringRefresh = silent
      && state.userInteractionRevision !== interactionRevision;
    if (!userStartedEditingDuringRefresh) renderView(state.activeTab);
    if (!silent) $('startFeedback').textContent = '控制台已同步。';
  } catch (error) {
    $('runtimeStatus').textContent = `连接失败：${error.message}`;
  } finally {
    state.refreshing = false;
    if (state.refreshQueued) {
      state.refreshQueued = false;
      refresh({ silent: true }).catch(() => {});
    }
  }
}

async function bootstrapInitialRender() {
  try {
    await fetchConfigState();
    setTab(state.activeTab || 'run');
    renderRegistrationChangeEmailSettings();
  } catch (error) {
    $('runtimeStatus').textContent = `配置加载失败：${error.message}`;
  }
  await refresh({ lightweight: false });
}

const REFINING_PLAN_LABELS = {
  plus: 'Plus', pro: 'Pro', team: 'Team', codex_low: 'Codex',
};
const REFINING_LINK_LABELS = {
  hosted: 'Hosted', ph_short: 'Checkout 链接', paypal: 'PayPal', gopay: 'GoPay',
  ideal: 'iDEAL', twint: 'TWINT', upi: 'UPI', pix: 'PIX', momo: 'MoMo', gcash: 'GCash', kakao: 'Kakao Pay',
};
const REFINING_TWO_POOL_LINKS = new Set(['ph_short', 'paypal', 'gopay', 'ideal', 'twint', 'upi', 'gcash', 'kakao']);
const FALLBACK_COUNTRY_CURRENCY = {
  US: 'USD', DE: 'EUR', FR: 'EUR', NL: 'EUR', IN: 'INR', ID: 'IDR', BR: 'BRL',
  VN: 'VND', GB: 'GBP', JP: 'JPY', KR: 'KRW', PH: 'PHP', AU: 'AUD', CA: 'CAD', CH: 'CHF',
};

function replaceOptions(select, values, selected, labels = {}) {
  if (!select) return;
  select.replaceChildren(...values.map((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = labels[value] || value;
    option.selected = value === selected;
    return option;
  }));
  if (values.includes(selected)) select.value = selected;
}

function renderRefiningProxySelect(select, selected) {
  if (!select) return;
  const pools = state.proxyCatalog?.checkout || [];
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = pools.length ? '请选择 checkout 代理池' : '暂无 checkout 代理池';
  select.replaceChildren(empty, ...pools.map((pool) => {
    const option = document.createElement('option');
    option.value = pool.id;
    option.textContent = poolLabel(pool);
    option.selected = pool.id === selected;
    return option;
  }));
  select.value = pools.some((pool) => pool.id === selected) ? selected : '';
}

function refiningProviderLabel(provider) {
  return ({
    public_cdk: '公共提炼',
    gc_tacmon: 'GC 提炼',
  })[provider] || 'PAY.153';
}

function refiningProviderEyebrow(provider) {
  return ({
    public_cdk: 'PUBLIC CDK',
    gc_tacmon: 'MK GC',
  })[provider] || 'PAY.153';
}

function pipelineStageConcurrency(stage) {
  return Math.max(0, Number(state.pipelineConcurrency?.stages?.[stage]?.concurrency) || 0);
}

function syncRefiningConditionalFields({ applyProviderDefault = false } = {}) {
  const provider = $('refiningProvider')?.value || 'pay153';
  const isPublic = provider === 'public_cdk';
  const isTacmon = provider === 'gc_tacmon';
  const isPay153 = !isPublic && !isTacmon;
  const plan = $('refiningPlan')?.value || 'plus';
  const linkType = $('refiningLinkType')?.value || 'hosted';
  $('refiningPay153Connection').hidden = !isPay153;
  $('refiningPublicConnection').hidden = !isPublic;
  $('refiningGcTacmonConnection').hidden = !isTacmon;
  $('refiningProxyFields').hidden = false;
  $('refiningExitProxyField').hidden = isPublic || (isPay153 && !REFINING_TWO_POOL_LINKS.has(linkType));
  $('refiningPay153TaskFields').hidden = !isPay153;
  $('refiningPublicQuotaHint').hidden = !isPublic;
  $('refiningProviderStatusLabel').textContent = refiningProviderLabel(provider);
  $('refiningProviderEyebrow').textContent = refiningProviderEyebrow(provider);
  $('refiningTeamFields').hidden = !isPay153 || plan !== 'team';
  $('refiningCodexFields').hidden = !isPay153 || plan !== 'codex_low';
  $('refiningPaypalFields').hidden = !isPay153 || linkType !== 'paypal';
  $('refiningGcashFields').hidden = !isPay153 || linkType !== 'gcash';
  $('refiningPixFields').hidden = !isPay153 || linkType !== 'pix';
  $('refiningPromoCampaignField').hidden = plan !== 'plus' || !$('refiningUsePromo').checked;
  if (isPay153 && applyProviderDefault) {
    const defaults = state.refiningCapabilities?.provider_defaults?.[linkType];
    if (defaults?.country) $('refiningCountry').value = defaults.country;
    if (defaults?.currency) $('refiningCurrency').value = defaults.currency;
  }
  const retryLimit = isPublic ? 50 : (isTacmon ? 10 : (linkType === 'gopay' ? 20 : 10));
  $('refiningRetryCount').max = String(retryLimit);
  if (Number($('refiningRetryCount').value) > retryLimit) $('refiningRetryCount').value = String(retryLimit);
  if (isPublic) {
    const pool = (state.proxyCatalog?.checkout || []).find((entry) => entry.id === $('refiningEntryProxyPool')?.value);
    $('refiningProxyRequirement').textContent = `公共服务传输使用所选代理池；当前 ${pool?.count || 0} 条。`;
    const quota = state.refining?.publicQuota;
    $('refiningPublicQuotaHint').textContent = quota?.lastVerifiedRemaining === null || quota?.lastVerifiedRemaining === undefined
      ? '公共服务会在提交前核验 CDK 余额，并按账号数预占在途额度。'
      : `CDK 上次核验剩余 ${quota.lastVerifiedRemaining} · 在途锁定 ${quota.reserved || 0} · 当前可提交 ${quota.available || 0}`;
    return;
  }
  if (isTacmon) {
    const concurrency = pipelineStageConcurrency('refining');
    const retries = Math.max(1, Math.min(retryLimit, Number($('refiningRetryCount')?.value || 1)));
    const required = concurrency * (retries + 1);
    const entry = (state.proxyCatalog?.checkout || []).find((item) => item.id === $('refiningEntryProxyPool')?.value);
    const exit = (state.proxyCatalog?.checkout || []).find((item) => item.id === $('refiningExitProxyPool')?.value);
    $('refiningProxyRequirement').textContent = `GC 每个角色至少需要 ${required} 条；站点池 ${entry?.count || 0} 条，执行池 ${exit?.count || entry?.count || 0} 条。`;
    return;
  }
  const concurrency = pipelineStageConcurrency('refining');
  const retries = Math.max(1, Math.min(retryLimit, Number($('refiningRetryCount')?.value || 1)));
  const required = concurrency * retries;
  const entry = (state.proxyCatalog?.checkout || []).find((item) => item.id === $('refiningEntryProxyPool')?.value);
  const exit = (state.proxyCatalog?.checkout || []).find((item) => item.id === $('refiningExitProxyPool')?.value);
  const exitText = REFINING_TWO_POOL_LINKS.has(linkType) ? `，出口池 ${exit?.count || entry?.count || 0} 条` : '';
  $('refiningProxyRequirement').textContent = `当前每个角色至少需要 ${required} 条不重复代理；入口池 ${entry?.count || 0} 条${exitText}。`;
}

function renderRefiningSettings() {
  const config = state.refining?.settings;
  if ($('refiningConcurrency')) $('refiningConcurrency').textContent = String(pipelineStageConcurrency('refining'));
  if (!config || state.refiningDraftDirty) return;
  const active = document.activeElement;
  const capabilities = state.refiningCapabilities || {};
  $('refiningProvider').value = config.provider || 'pay153';
  const plans = capabilities.plans || ['plus', 'pro', 'team', 'codex_low'];
  const links = (capabilities.link_types || Object.keys(REFINING_LINK_LABELS))
    .filter((value) => !(capabilities.disabled_link_types || []).includes(value));
  const countries = Object.keys(capabilities.country_currency || FALLBACK_COUNTRY_CURRENCY);
  replaceOptions($('refiningPlan'), plans, config.plan, REFINING_PLAN_LABELS);
  replaceOptions($('refiningLinkType'), links, config.linkType, REFINING_LINK_LABELS);
  replaceOptions($('refiningCountry'), countries, config.country, Object.fromEntries(countries.map((code) => [code, `${code} · ${(capabilities.country_currency || FALLBACK_COUNTRY_CURRENCY)[code]}`])));
  $('refiningServiceBaseUrl').value = config.serviceBaseUrl || '';
  $('refiningPublicServiceBaseUrl').value = config.publicServiceBaseUrl || '';
  $('refiningPublicCdk').value = '';
  $('refiningPublicCdk').placeholder = config.publicCdkConfigured ? '已保存；输入新 CDK 可覆盖' : '未配置';
  if ($('refiningBatchWindowSeconds') && active !== $('refiningBatchWindowSeconds')) $('refiningBatchWindowSeconds').value = Number(config.batchWindowSeconds ?? 10);
  $('refiningGcTacmonServiceBaseUrl').value = config.gcTacmonServiceBaseUrl || '';
  $('refiningInternalKey').value = '';
  $('refiningInternalKey').placeholder = config.internalKeyConfigured ? '已保存；输入新密钥可覆盖' : '未配置';
  $('refiningEnabled').checked = Boolean(config.enabled);
  $('refiningCurrency').value = config.currency || 'USD';
  $('refiningRetryCount').value = config.retryCount || 3;
  $('refiningDeleteFailedAccounts').checked = config.deleteFailedAccounts !== false;
  $('refiningUsePromo').checked = Boolean(config.usePromo);
  $('refiningPromoCampaign').value = config.promoCampaign || '';
  $('refiningUseSentinel').checked = Boolean(config.useSentinel);
  $('refiningWorkspaceName').value = config.workspaceName || 'Codex Workspace';
  $('refiningCodexWorkspaceName').value = config.workspaceName || 'Codex Space';
  $('refiningWorkspaceId').value = config.workspaceId || '';
  $('refiningSeatQuantity').value = config.seatQuantity || 5;
  $('refiningPriceInterval').value = config.priceInterval || 'month';
  $('refiningCreditQuantity').value = config.creditQuantity || 13;
  $('refiningPromoCode').value = config.promoCode || '';
  $('refiningPaypalProxyRouteMode').value = config.paypalProxyRouteMode || 'current';
  $('refiningPaypalExtractMode').value = config.paypalExtractMode || 'stripe';
  $('refiningPaypalCountry').value = config.paypalCustomBillingCountry || 'US';
  $('refiningPaypalPromoMode').value = config.paypalPromoMode || 'auto_by_session';
  $('refiningGcashPromoMode').value = config.gcashPromoMode || 'native_only';
  $('refiningPixAutoKind').value = config.pixAutoKind || 'cpf';
  $('refiningPixTaxId').value = config.pixTaxId || '';
  renderRefiningProxySelect($('refiningEntryProxyPool'), config.entryProxyPoolId || '');
  renderRefiningProxySelect($('refiningExitProxyPool'), config.exitProxyPoolId || config.entryProxyPoolId || '');
  syncRefiningConditionalFields();
}

function refiningJobLabel(status) {
  return ({
    pending: '待提交', dispatching: '正在提交', queued: '排队中', running: '提炼中', done: '提炼成功',
    error: '提炼失败', cancelled: '已停止', remote_unknown: '远端状态未知', remote_lost: '远端状态丢失',
  })[status] || '可加入';
}

const REFINING_ACTIVE_STATUSES = new Set(['pending', 'dispatching', 'queued', 'running']);
const REFINING_RETRYABLE_STATUSES = new Set(['error', 'cancelled', 'remote_unknown', 'remote_lost']);

function refiningJobSortRank(status) {
  return ({
    pending: 0,
    dispatching: 1,
    queued: 2,
    running: 3,
    error: 4,
    remote_unknown: 5,
    remote_lost: 6,
    cancelled: 7,
    done: 8,
  })[status] ?? 99;
}

function renderRefiningJobRow(email, account, job) {
  const row = document.createElement('article');
  row.className = 'refining-job-row';
  row.dataset.status = job.status || 'ready';
  row.dataset.kind = REFINING_ACTIVE_STATUSES.has(job.status) ? 'active' : 'problem';

  const identity = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = email;
  const meta = document.createElement('code');
  meta.textContent = [
    paymentMethodLabel(account),
    paymentCheckoutType(account) || '无 checkout',
    account.passwordStatus === 'has_password' ? '有密码' : '无密码',
    eligibilityText(account),
  ].filter(Boolean).join(' · ');
  identity.append(title, meta);

  const status = document.createElement('div');
  status.className = 'refining-job-state';
  const statusLabel = document.createElement('strong');
  statusLabel.textContent = `${refiningJobLabel(job.status)}${job.status === 'running' ? ` ${Math.round(Number(job.percent || 0))}%` : ''}`;
  const statusDetail = document.createElement('span');
  const updatedAt = job.updatedAt || account.updatedAt || account.createdAt || '';
  statusDetail.textContent = [
    job.text || '',
    job.error || '',
    job.resultUrl ? '有结果链接' : '',
    updatedAt ? new Date(updatedAt).toLocaleString() : '',
  ].filter(Boolean).join(' · ') || '等待更新';
  status.append(statusLabel, statusDetail);

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  if (job.resultUrl) {
    const open = document.createElement('a');
    open.href = job.resultUrl;
    open.target = '_blank';
    open.rel = 'noreferrer';
    open.className = 'link-button';
    open.textContent = '查看结果';
    actions.append(open);
  }
  if (REFINING_RETRYABLE_STATUSES.has(job.status)) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重试';
    retry.addEventListener('click', () => retryRefiningAccount(email));
    actions.append(retry);
  }
  row.append(identity, status, actions);
  return row;
}

function renderRefiningJobs() {
  const list = $('refiningJobList');
  if (!list) return;
  const accountMap = accountByEmail();
  const rows = state.emails
    .filter((entry) => entry.mailboxSource === 'mail_com_split' && entry.mailComStage === 'refining')
    .map((entry) => {
      const account = accountMap.get(String(entry.email).toLowerCase()) || {};
      return { email: entry.email, account, job: account.refiningJob || {} };
    })
    .filter(({ job }) => REFINING_ACTIVE_STATUSES.has(job.status) || REFINING_RETRYABLE_STATUSES.has(job.status))
    .sort((left, right) => refiningJobSortRank(left.job.status) - refiningJobSortRank(right.job.status)
      || String(right.job.updatedAt || right.account.updatedAt || '').localeCompare(String(left.job.updatedAt || left.account.updatedAt || '')))
    .map(({ email, account, job }) => renderRefiningJobRow(email, account, job));
  list.replaceChildren(...(rows.length ? rows : [item({ title: '当前没有运行中的任务', meta: '正在提炼或失败待重试的账号会显示在这里' })]));
}

function renderRefiningBatches() {
  const batches = state.refining?.runtime?.batches || [];
  const recent = [...batches]
    .sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')))
    .slice(0, 5);
  $('refiningBatchList')?.replaceChildren(...(recent.length ? recent.map((batch) => item({
    title: `${batch.status || 'unknown'} · ${batch.emails?.length || 0} 个账号`,
    meta: `${batch.remoteBatchId || '尚无远端批次'} · ${batch.summary ? `成功 ${batch.summary.done || 0} / 失败 ${batch.summary.error || 0}` : batch.createdAt || ''}`,
    status: batch.status,
  })) : [item({ title: '暂无批次', meta: '账号入队并提交后会显示在这里' })]));
}

function renderRefining() {
  if (!state.refining) return;
  const summary = state.refining.summary || {};
  const active = Number(summary.dispatching || 0) + Number(summary.queued || 0) + Number(summary.running || 0);
  const provider = state.refining.settings?.provider || 'pay153';
  $('refiningProviderStatusLabel').textContent = refiningProviderLabel(provider);
  $('refiningProviderEyebrow').textContent = refiningProviderEyebrow(provider);
  $('refiningServiceState').textContent = state.refiningServiceOnline ? '在线' : '未检测';
  $('refiningAutomationState').textContent = state.refining.settings?.enabled ? '已开启' : '关闭';
  $('refiningReadyCount').textContent = String(summary.ready || 0);
  $('refiningActiveCount').textContent = String(active);
  renderRefiningSettings();
  renderRefiningJobs();
  renderRefiningBatches();
}

function refiningSettingsPayload() {
  const plan = $('refiningPlan').value;
  const provider = $('refiningProvider').value;
  return {
    provider,
    publicCdk: $('refiningPublicCdk').value,
    serviceBaseUrl: $('refiningServiceBaseUrl').value,
    internalKey: $('refiningInternalKey').value,
    enabled: $('refiningEnabled').checked,
    plan,
    linkType: $('refiningLinkType').value,
    country: $('refiningCountry').value,
    currency: $('refiningCurrency').value,
    batchWindowSeconds: Number($('refiningBatchWindowSeconds')?.value || 10),
    retryCount: Number($('refiningRetryCount').value),
    deleteFailedAccounts: $('refiningDeleteFailedAccounts').checked,
    entryProxyPoolId: $('refiningEntryProxyPool').value,
    exitProxyPoolId: $('refiningExitProxyPool').value,
    usePromo: $('refiningUsePromo').checked,
    promoCampaign: $('refiningPromoCampaign').value,
    useSentinel: $('refiningUseSentinel').checked,
    workspaceName: plan === 'codex_low' ? $('refiningCodexWorkspaceName').value : $('refiningWorkspaceName').value,
    workspaceId: $('refiningWorkspaceId').value,
    seatQuantity: Number($('refiningSeatQuantity').value),
    priceInterval: $('refiningPriceInterval').value,
    creditQuantity: Number($('refiningCreditQuantity').value),
    promoCode: $('refiningPromoCode').value,
    paypalProxyRouteMode: $('refiningPaypalProxyRouteMode').value,
    paypalExtractMode: $('refiningPaypalExtractMode').value,
    paypalCustomBillingCountry: $('refiningPaypalCountry').value,
    paypalPromoMode: $('refiningPaypalPromoMode').value,
    gcashPromoMode: $('refiningGcashPromoMode').value,
    pixAutoKind: $('refiningPixAutoKind').value,
    pixTaxId: $('refiningPixTaxId').value,
  };
}

async function testRefiningService() {
  const provider = state.refining?.settings?.provider || 'pay153';
  const label = refiningProviderLabel(provider);
  $('refiningFeedback').textContent = `正在检测 ${label}…`;
  try {
    const result = await api.post('/api/refining/test', {});
    state.refiningCapabilities = result.capabilities || null;
    state.refiningServiceOnline = Boolean(result.health?.ok);
    $('refiningFeedback').textContent = provider === 'public_cdk'
      ? `公共提炼服务在线 · CDK 剩余 ${Number(result.health?.remaining || 0)} 次`
      : provider === 'gc_tacmon'
        ? `GC 提炼在线 · ${result.capabilities?.fixed_service_url || ''}`
        : `PAY.153 在线 · 最多 ${result.capabilities?.task_limits?.workers || 30} 个并发 worker`;
    renderRefining();
  } catch (error) {
    state.refiningServiceOnline = false;
    $('refiningFeedback').textContent = `连接失败：${error.message}`;
    renderRefining();
  }
}

async function retryRefiningAccount(email) {
  $('refiningFeedback').textContent = `正在重新入队：${email}`;
  try {
    await api.post(`/api/refining/accounts/${encodeURIComponent(email)}/retry`, {});
    await refresh({ silent: true });
    $('refiningFeedback').textContent = `已重新入队：${email}`;
  } catch (error) {
    $('refiningFeedback').textContent = `重试失败：${error.message}`;
  }
}


function selectedProbeProxyPool(config, field = 'proxyPoolId') {
  const pools = state.proxyCatalog?.payment || [];
  const configured = String(config?.[field] || config?.proxyPoolId || config?.entryProxyPoolId || '').trim();
  if (configured && pools.some((pool) => pool.id === configured)) return configured;
  return DIRECT_PROXY_VALUE;
}

function renderProbeProxySelect(select, config, field) {
  const pools = state.proxyCatalog?.payment || [];
  const current = selectedProbeProxyPool(config, field);
  const direct = document.createElement('option');
  direct.value = DIRECT_PROXY_VALUE;
  direct.textContent = '未配置（不会自动选择）';
  direct.selected = current === DIRECT_PROXY_VALUE;
  select.replaceChildren(direct, ...pools.map((pool) => {
    const option = document.createElement('option');
    option.value = pool.id;
    option.textContent = poolLabel(pool);
    option.selected = pool.id === current;
    return option;
  }));
}


function renderRegistrationChangeEmailSettings() {
  if (state.registrationChangeEmailDraftDirty) return;
  const config = state.registrationChangeEmailSettings || state.config?.registration?.changeEmail || {};
  const active = document.activeElement;
  if ($('registrationSetupPassword')) $('registrationSetupPassword').checked = config.setupPassword === true;
  if ($('registrationSetupTotp2fa')) $('registrationSetupTotp2fa').checked = config.setupTotp2fa === true;
  if ($('registrationValidateOauthSession')) $('registrationValidateOauthSession').checked = config.validateOauthSession === true;
  if ($('registrationAutoCheckEligibility')) $('registrationAutoCheckEligibility').checked = config.autoCheckEligibility === true;
  if ($('registrationPhoneBindProbeEnabled')) $('registrationPhoneBindProbeEnabled').checked = config.phoneBindProbeEnabled === true;
  if ($('registrationChangeEmailBaseUrl') && active !== $('registrationChangeEmailBaseUrl')) $('registrationChangeEmailBaseUrl').value = config.domainMailboxBaseUrl || 'http://127.0.0.1:3102';
  if ($('registrationChangeEmailApiToken')) $('registrationChangeEmailApiToken').placeholder = config.domainMailboxApiTokenConfigured ? '已保存；输入新 Token 可覆盖' : '3102 邮箱 API Token';
  if ($('registrationChangeEmailDomain') && active !== $('registrationChangeEmailDomain')) $('registrationChangeEmailDomain').value = config.domain || '';
  if ($('registrationChangeEmailLocalPartPrefix') && active !== $('registrationChangeEmailLocalPartPrefix')) $('registrationChangeEmailLocalPartPrefix').value = config.localPartPrefix || '';
  if ($('registrationChangeEmailTimeoutSeconds') && active !== $('registrationChangeEmailTimeoutSeconds')) $('registrationChangeEmailTimeoutSeconds').value = Number(config.timeoutSeconds || 120);
  if ($('registrationChangeEmailPollIntervalMs') && active !== $('registrationChangeEmailPollIntervalMs')) $('registrationChangeEmailPollIntervalMs').value = Number(config.pollIntervalMs || 3000);
  if ($('registrationPostRegistrationDelaySeconds') && active !== $('registrationPostRegistrationDelaySeconds')) $('registrationPostRegistrationDelaySeconds').value = Number(config.postRegistrationDelaySeconds || 0);
  if ($('registrationChangeEmailEnabled')) $('registrationChangeEmailEnabled').checked = Boolean(config.enabled);
  if ($('registrationChangeEmailFailRegistrationOnError')) $('registrationChangeEmailFailRegistrationOnError').checked = Boolean(config.failRegistrationOnError);
  if ($('registrationChangeEmailFeedback')) {
    const passwordText = config.setupPassword === true ? '创建密码' : '不创建密码';
    const totpText = config.setupTotp2fa === true ? '设置 2FA' : '不设置 2FA';
    const changeText = config.enabled ? `改邮箱到 ${config.domain || '未配置域名'}` : '不改邮箱';
    const oauthText = config.validateOauthSession === true ? '验证登录态' : '不验证登录态';
    const phoneProbeText = config.phoneBindProbeEnabled === true ? '验证接码入口' : '不验证接码入口';
    const pollText = `取码轮询 ${Number(config.pollIntervalMs || 3000)} 毫秒`;
    const delayText = Number(config.postRegistrationDelaySeconds || 0) > 0 ? `延迟 ${Number(config.postRegistrationDelaySeconds || 0)} 秒后执行` : '不延迟';
    $('registrationChangeEmailFeedback').textContent = `${passwordText} · ${totpText} · ${oauthText} · ${phoneProbeText} · ${changeText} · ${delayText} · ${pollText}`;
  }
}

function renderPaymentMethodProbeSettings() {
  if (state.paymentMethodProbeDraftDirty) return;
  const config = state.paymentMethodProbeSettings || {};
  if ($('paymentMethodProbeProxyPool')) renderProbeProxySelect($('paymentMethodProbeProxyPool'), config, 'proxyPoolId');
  if ($('paymentMethodProbeFeedback')) {
    const pool = (state.proxyCatalog?.payment || []).find((item) => item.id === (config.proxyPoolId || config.entryProxyPoolId || ''));
    const poolText = pool ? poolLabel(pool) : (config.proxyPoolId || config.entryProxyPoolId || '未配置代理池');
    $('paymentMethodProbeFeedback').textContent = `注册完成后必检 · ${poolText}`;
  }
}

function renderPaymentSettings() {
  if (state.paymentDraftDirty) return;
  const config = state.paymentSettings || {};
  const active = document.activeElement;
  if ($('paymentProxyPoolSelect')) {
    renderConfiguredProxySelect($('paymentProxyPoolSelect'), 'payment', config.proxyPoolId || '');
  }
  if ($('paymentServiceBaseUrl') && active !== $('paymentServiceBaseUrl')) $('paymentServiceBaseUrl').value = config.serviceBaseUrl || '';
  if ($('paymentSmsCountry') && active !== $('paymentSmsCountry')) $('paymentSmsCountry').value = config.smsCountry || '';
  if ($('paymentSmsPriceMin') && active !== $('paymentSmsPriceMin')) $('paymentSmsPriceMin').value = Number(config.smsPriceMin || 0);
  if ($('paymentSmsPriceMax') && active !== $('paymentSmsPriceMax')) $('paymentSmsPriceMax').value = Number(config.smsPriceMax || 0);
  if ($('paymentSmsTimeoutSeconds') && active !== $('paymentSmsTimeoutSeconds')) $('paymentSmsTimeoutSeconds').value = Number(config.smsTimeoutSeconds || 180);
  if ($('paymentSmsMaxAttempts') && active !== $('paymentSmsMaxAttempts')) $('paymentSmsMaxAttempts').value = Number(config.smsMaxAttempts || 12);
  if ($('paymentPollIntervalMs') && active !== $('paymentPollIntervalMs')) $('paymentPollIntervalMs').value = Number(config.pollIntervalMs || 3000);
  if ($('paymentSmsPhoneRetryLimit') && active !== $('paymentSmsPhoneRetryLimit')) $('paymentSmsPhoneRetryLimit').value = Number(config.smsPhoneRetryLimit ?? 2);
  if ($('paymentTaskRetryLimit') && active !== $('paymentTaskRetryLimit')) $('paymentTaskRetryLimit').value = Number(config.paymentTaskRetryLimit ?? 1);
  if ($('paymentSmsProviderRank') && active !== $('paymentSmsProviderRank')) $('paymentSmsProviderRank').value = config.smsPreferGold === false ? 'all' : 'gold';
  if ($('paymentEnabled')) $('paymentEnabled').checked = Boolean(config.enabled);
  if ($('paymentSettingsFeedback')) {
    const pool = (state.proxyCatalog?.payment || []).find((item) => item.id === (config.proxyPoolId || ''));
    const poolText = pool ? poolLabel(pool) : (config.proxyPoolId ? config.proxyPoolId : '直连');
    $('paymentSettingsFeedback').textContent = `${config.enabled ? '自动支付已开启' : '自动支付已关闭'} · SMSBower ${config.smsApiKey ? '已配置' : '未配置'} · ${poolText} · 轮询 ${Number(config.pollIntervalMs || 3000)} 毫秒`;
  }
}

function renderPhoneBindSettings() {
  if (state.phoneBindSettingsDraftDirty) return;
  const config = state.phoneBindSettings || {};
  const active = document.activeElement;
  if ($('phoneBindSub2BaseUrl') && active !== $('phoneBindSub2BaseUrl')) $('phoneBindSub2BaseUrl').value = config.sub2BaseUrl || '';
  if ($('phoneBindSub2AdminApiKey')) $('phoneBindSub2AdminApiKey').placeholder = config.hasAdminApiKey ? '已保存；输入新密钥可覆盖' : 'Sub2API 管理员 API Key';
  if ($('phoneBindSmsApiKey')) $('phoneBindSmsApiKey').placeholder = config.smsApiKey ? '已保存；输入新密钥可覆盖' : 'SMSBower API Key';
  renderPhoneBindCountryOptions(config);
  if ($('phoneBindSmsPriceMin') && active !== $('phoneBindSmsPriceMin')) $('phoneBindSmsPriceMin').value = Number(config.smsPriceMin || 0);
  if ($('phoneBindSmsPriceMax') && active !== $('phoneBindSmsPriceMax')) $('phoneBindSmsPriceMax').value = Number(config.smsPriceMax || 0);
  if ($('phoneBindSmsTimeoutSeconds') && active !== $('phoneBindSmsTimeoutSeconds')) $('phoneBindSmsTimeoutSeconds').value = Number(config.smsTimeoutSeconds || 180);
  if ($('phoneBindSmsMaxAttempts') && active !== $('phoneBindSmsMaxAttempts')) $('phoneBindSmsMaxAttempts').value = Number(config.smsMaxAttempts || 12);
  if ($('phoneBindSmsPhoneRetryLimit') && active !== $('phoneBindSmsPhoneRetryLimit')) $('phoneBindSmsPhoneRetryLimit').value = Number(config.smsPhoneRetryLimit ?? 2);
  if ($('phoneBindSmsProviderRank') && active !== $('phoneBindSmsProviderRank')) $('phoneBindSmsProviderRank').value = config.smsPreferGold === false ? 'all' : 'gold';
  if ($('phoneBindAutoEnabled')) $('phoneBindAutoEnabled').checked = Boolean(config.autoEnabled);
  if ($('phoneBindSettingsFeedback')) {
    $('phoneBindSettingsFeedback').textContent = `${config.autoEnabled ? '自动接码已开启' : '自动接码已关闭'} · 动态额度 ${pipelineStageConcurrency('phoneBind')} · ${config.sub2BaseUrl ? 'Sub2API 已配置' : 'Sub2API 未配置'} · ${config.smsApiKey ? 'OpenAI 接码已配置' : 'OpenAI 接码未配置'}`;
  }
}

function renderPhoneBindCountryOptions(config = {}) {
  const select = $('phoneBindSmsCountries');
  if (!select) return;
  const savedCountries = (config.smsCountries || ['16']).map(String);
  const savedSignature = savedCountries.join(',');
  if (!(state.phoneBindCountrySelection instanceof Set)
    || (!state.phoneBindCountrySelectionDirty && state.phoneBindCountrySelectionSource !== savedSignature)) {
    state.phoneBindCountrySelection = new Set(savedCountries);
    state.phoneBindCountrySelectionSource = savedSignature;
  }
  const query = String($('phoneBindSmsCountrySearch')?.value || '').trim().toLowerCase();
  const options = (config.smsCountryOptions || []).filter((country) => {
    if (!query) return true;
    return [country.id, country.name, country.chn, country.eng]
      .some((value) => String(value || '').toLowerCase().includes(query));
  });
  const renderSignature = JSON.stringify({
    query,
    selected: [...state.phoneBindCountrySelection].sort(),
    options: options.map((country) => [String(country.id), Number(country.trust ?? 100)]),
  });
  if (select.dataset.renderSignature !== renderSignature) {
    const previousScrollTop = select.scrollTop;
    select.textContent = '';
    for (const country of options) {
      const option = document.createElement('option');
      option.value = String(country.id);
      option.selected = state.phoneBindCountrySelection.has(option.value);
      option.textContent = `${country.name || country.chn || country.eng} / ${country.eng || '-'} (#${country.id}) · 信任 ${Number(country.trust ?? 100)}`;
      select.append(option);
    }
    select.dataset.renderSignature = renderSignature;
    select.scrollTop = previousScrollTop;
  }
  if ($('phoneBindSmsCountryCount')) {
    const policy = config.smsTrustPolicy || {};
    $('phoneBindSmsCountryCount').textContent = `已选 ${state.phoneBindCountrySelection.size} 个 · 国家失败 -${policy.countryFailurePenalty ?? 8}/成功 +${policy.countrySuccessReward ?? 2} · 价格档失败 -${policy.tierFailurePenalty ?? 12}/成功 +${policy.tierSuccessReward ?? 3}`;
  }
  if ($('phoneBindSmsTierTrust')) {
    const names = new Map((config.smsCountryOptions || []).map((country) => [String(country.id), country.name || country.eng || country.id]));
    const learned = Object.entries(config.smsTierTrust || {})
      .map(([key, entry]) => {
        const [countryId, rawPrice] = key.split('|');
        return { countryId, price: Number(rawPrice), score: Number(entry?.score ?? 100), successes: Number(entry?.successes || 0), failures: Number(entry?.failures || 0) };
      })
      .filter((item) => state.phoneBindCountrySelection.has(item.countryId))
      .sort((left, right) => left.countryId.localeCompare(right.countryId) || left.price - right.price);
    const summary = learned.slice(0, 6).map((item) => `${names.get(item.countryId) || item.countryId} $${item.price.toFixed(2)}=${item.score}分（成${item.successes}/败${item.failures}）`);
    $('phoneBindSmsTierTrust').textContent = summary.length
      ? `已学习价格档：${summary.join(' · ')}${learned.length > summary.length ? ` · 另 ${learned.length - summary.length} 档` : ''}`
      : '暂无已学习价格档';
  }
}

function renderCloudflareMailboxConfig() {
  const config = state.cfMailbox || {};
  const active = document.activeElement;
  if ($('cfBaseUrl') && active !== $('cfBaseUrl')) $('cfBaseUrl').value = config.baseUrl || '';
  const selected = config.defaultDomain || (config.domains || [])[0] || '';
  if ($('cfDomains') && active !== $('cfDomains')) {
    const domains = [...new Set([selected, ...state.cfDomainOptions].map(normalizeDomain).filter(Boolean))];
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = domains.length ? '选择域名' : '先点击获取';
    $('cfDomains').replaceChildren(placeholder, ...domains.map((domain) => {
      const option = document.createElement('option');
      option.value = domain;
      option.textContent = domain;
      option.selected = domain === selected;
      return option;
    }));
    $('cfDomains').value = selected;
  }
  if ($('cfUsernamePrefix') && active !== $('cfUsernamePrefix')) $('cfUsernamePrefix').value = config.usernamePrefix || '';
  if ($('cfRandomSubdomain')) {
    $('cfRandomSubdomain').disabled = false;
    if (active !== $('cfRandomSubdomain')) $('cfRandomSubdomain').checked = Boolean(config.randomSubdomain);
    $('cfRandomSubdomain').title = '';
  }
  if ($('cfRunUsernamePrefix') && active !== $('cfRunUsernamePrefix')) $('cfRunUsernamePrefix').value = config.usernamePrefix || '';
  if ($('cfAdminAuth')) $('cfAdminAuth').placeholder = config.hasAdminAuth ? '已保存；输入新密码可覆盖' : 'Worker 管理密码';
  if ($('cfMailboxFeedback')) {
    const domainText = normalizeDomain(config.defaultDomain || (config.domains || [])[0]) || '未配置域名';
    $('cfMailboxFeedback').textContent = `${config.baseUrl ? '已配置' : '未配置'} · ${domainText}`;
  }
}

function formatPipelineWait(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  if (!seconds) return '-';
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function renderPipelineConcurrency() {
  const plan = state.pipelineConcurrency;
  if (!plan?.stages) return;
  const resources = plan.adaptive?.resources || {};
  const summary = $('pipelineResourceSummary');
  if (summary) {
    const load = Number.isFinite(Number(resources.load1)) ? Number(resources.load1).toFixed(2) : '-';
    const memory = Number.isFinite(Number(resources.freeMemoryMb)) ? `${Math.round(Number(resources.freeMemoryMb))} MB` : '-';
    const admission = plan.stages.registration?.admissionOpen ? '注册准入' : '暂停新注册';
    summary.textContent = `${admission} · CPU 负载 ${load}/${plan.hardware?.cpuCores || '-'} · 可用内存 ${memory} · 资源倍率 ${Math.round(Number(resources.pressure || 0) * 100)}%`;
  }
  for (const key of ['registration', 'paymentMethod', 'refining', 'finalPayment', 'phoneBind']) {
    const stage = plan.stages[key] || {};
    const row = document.querySelector(`[data-pipeline-stage="${key}"]`);
    if (!row) continue;
    const active = Math.max(0, Number(stage.active) || 0);
    const demand = Math.max(active, Number(stage.demand) || 0);
    const allocation = key === 'registration'
      ? `${Math.max(0, Number(stage.effectiveConcurrency) || 0)} / ${Math.max(0, Number(stage.concurrency) || 0)}`
      : `${Math.max(0, Number(stage.concurrency) || 0)} / ${Math.max(0, Number(stage.maxConcurrency) || 0)}`;
    row.querySelector('[data-field="active"]').textContent = String(active);
    row.querySelector('[data-field="queued"]').textContent = String(Math.max(0, demand - active));
    row.querySelector('[data-field="allocation"]').textContent = allocation;
    row.querySelector('[data-field="wait"]').textContent = formatPipelineWait(
      key === 'registration' ? stage.waitingMs : plan.adaptive?.waitingMs?.[key],
    );
  }
}

function renderMailComSplitConfig() {
  const config = state.config?.registration?.autoStart || {};
  const active = document.activeElement;
  const draft = state.mailComDraft || {};
  const autoEnabled = config.runtime?.autoEnabled ?? config.enabled === true;
  if ($('mailComMainImport') && active !== $('mailComMainImport')) {
    $('mailComMainImport').value = draft.mainImport || '';
  }
  if ($('mailComReserveTarget') && active !== $('mailComReserveTarget')) {
    $('mailComReserveTarget').value = String(
      Object.prototype.hasOwnProperty.call(draft, 'autoStartTarget') ? draft.autoStartTarget : config.mailComReserveTarget || 9,
    );
  }
  if ($('registrationAutoStartConcurrency') && active !== $('registrationAutoStartConcurrency')) {
    $('registrationAutoStartConcurrency').value = String(
      Object.prototype.hasOwnProperty.call(draft, 'autoStartConcurrency') ? draft.autoStartConcurrency : config.concurrency || 3,
    );
  }
  if ($('globalRegistrationAutoState')) {
    $('globalRegistrationAutoState').textContent = autoEnabled
      ? '自动任务运行中：按空闲槽持续读取可用邮箱'
      : '自动任务已停止：保存配置后点击启动';
  }
  if ($('startRegistrationAutoStart')) $('startRegistrationAutoStart').disabled = autoEnabled;
  if ($('stopRegistrationAutoStart')) $('stopRegistrationAutoStart').disabled = !autoEnabled;
  if ($('mailComSplitFeedback')) {
    const accountCount = Array.isArray(state.mailComAccounts) ? state.mailComAccounts.length : 0;
    const sharedDomainCount = mailComSharedDomains().length;
    const runtime = config.runtime || {};
    const target = Number(runtime.target || config.mailComReserveTarget || 9);
    $('mailComSplitFeedback').textContent = state.mailComFeedbackMessage
      || `${accountCount ? '已导入' : '未导入'} · ${accountCount} 个 mail.com 主邮箱 · 已同步后缀 ${sharedDomainCount} 个 · 分裂邮箱储备目标 ${target}`;
  }
  renderPipelineConcurrency();
  renderMailComDomainLookup();
}

function renderMailComSplitAccounts() {
  const container = $('mailComMainAccounts');
  if (!container) return;
  const accounts = Array.isArray(state.mailComAccounts) ? state.mailComAccounts : [];
  const sessionOf = (account) => ({ ...(account.session || {}), ...(state.mailComSessionOverrides?.[account.id] || {}) });
  const hasSessionState = (account) => {
    const session = sessionOf(account);
    return Boolean(session.open || ['open', 'opening', 'failed'].includes(session.status));
  };
  const openAccounts = accounts.filter((account) => mailComSessionReady(sessionOf(account)));
  const startedAccounts = accounts.filter(hasSessionState);
  const idleAccounts = accounts.filter((account) => !hasSessionState(account));
  const aliasCount = accounts.reduce(
    (total, account) => total + (Array.isArray(account.aliases) ? account.aliases.length : 0),
    0,
  );
  if ($('mailComAccountSummary')) {
    $('mailComAccountSummary').textContent = `${accounts.length} 个主邮箱 · 已开启 ${openAccounts.length} · ${aliasCount} 个分裂邮箱`;
  }
  renderMailComAutoStartLiveFeedback();
  if (!accounts.length) {
    container.replaceChildren(item({ title: '暂无主邮箱', meta: '按“邮箱----密码”批量导入后再登录' }));
    return;
  }
  ensureMailComDomainOptions();

  const makeMailboxGroup = ({ titleText, hintText, expanded, storageKey, toggleKey, accounts: groupAccounts, emptyTitle, emptyMeta }) => {
    const wrapper = document.createElement('section');
    wrapper.className = 'mail-com-account-manager';
    const heading = document.createElement('div');
    heading.className = 'mail-com-account-section-heading';
    const title = document.createElement('strong');
    title.textContent = titleText;
    const hint = document.createElement('span');
    hint.className = 'field-hint';
    hint.textContent = hintText;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'primary-mini';
    toggle.textContent = expanded ? '收起' : '展开';
    toggle.setAttribute('aria-expanded', String(Boolean(expanded)));
    toggle.addEventListener('click', () => {
      state[toggleKey] = !state[toggleKey];
      localStorage.setItem(storageKey, String(state[toggleKey]));
      renderMailComSplitAccounts();
    });
    heading.append(title, hint, toggle);
    wrapper.append(heading);

    if (expanded) {
      if (groupAccounts.length) {
        const list = document.createElement('div');
        list.className = 'split-account-list mail-com-managed-account-list';
        list.append(...groupAccounts.map((account) => renderMailComManagedAccount(account)));
        wrapper.append(list);
      } else {
        wrapper.append(item({ title: emptyTitle, meta: emptyMeta }));
      }
    } else {
      wrapper.append(item({
        title: `${titleText}已收起`,
        meta: groupAccounts.length ? `共 ${groupAccounts.length} 个，点击“展开”查看。` : emptyMeta,
      }));
    }
    return wrapper;
  };

  container.replaceChildren(
    makeMailboxGroup({
      titleText: '启动的会话',
      hintText: `${startedAccounts.length} 个已启动/打开中/失败 · 已打开 ${openAccounts.length}`,
      expanded: state.mailComStartedManagerOpen,
      storageKey: 'mailComStartedManagerOpen',
      toggleKey: 'mailComStartedManagerOpen',
      accounts: startedAccounts,
      emptyTitle: '暂无启动的会话',
      emptyMeta: '点击未启动主邮箱里的“打开后台会话”后，会移动到这里。',
    }),
    makeMailboxGroup({
      titleText: '未启动的会话',
      hintText: `${idleAccounts.length} 个未启动`,
      expanded: state.mailComManagerOpen,
      storageKey: 'mailComManagerOpen',
      toggleKey: 'mailComManagerOpen',
      accounts: idleAccounts,
      emptyTitle: '暂无未启动主邮箱',
      emptyMeta: '主邮箱会话都已经启动、打开中或有失败状态。',
    }),
  );
}
function mailComSessionReady(session = {}) {
  return session.open === true && session.status === 'open';
}

function renderMailComManagedAccount(account) {
  const node = document.createElement('article');
  node.className = 'split-account split-account-managed';
  const sessionOverride = state.mailComSessionOverrides?.[account.id] || {};
  const session = { ...(account.session || {}), ...sessionOverride };
  const sessionReady = mailComSessionReady(session);
  const header = document.createElement('div');
  header.className = 'split-account-header';
  const identity = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = account.email;
  const meta = document.createElement('code');
  const aliases = Array.isArray(account.aliases) ? account.aliases : [];
  const historicalAliasCount = Math.max(aliases.length, Number(account.historicalAliasCount || 0));
  const domainCount = Number(account.domainCount || account.availableDomains?.length || 0);
  const sessionText = session.status === 'opening'
    ? '会话打开中…'
    : sessionReady
      ? '会话已打开'
      : session.status === 'failed'
        ? `会话打开失败${session.lastError ? `：${session.lastError}` : ''}`
        : '会话未打开';
  meta.textContent = `${sessionText} · 当前 ${aliases.length}/9 · 历史记录 ${historicalAliasCount} 条（含失败预留） · ${domainCount ? `已同步后缀 ${domainCount}` : `使用共享后缀 ${mailComSharedDomains().length}`}`;
  identity.append(title, meta);
  const actions = document.createElement('div');
  actions.className = 'split-account-actions';
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = session.status === 'opening' ? '打开中…' : (sessionReady ? '重开会话' : '打开后台会话');
  open.className = 'primary-mini';
  open.disabled = session.status === 'opening';
  open.addEventListener('click', () => openMailComSplitSession(account));
  const create = document.createElement('button');
  const accountBusy = state.mailComBusyAccountIds.has(account.id);
  create.type = 'button';
  create.textContent = accountBusy ? '处理中…' : '创建分裂邮箱';
  create.className = 'primary-mini';
  create.disabled = accountBusy || !sessionReady;
  create.title = create.disabled ? '先打开后台会话，再创建分裂邮箱' : '使用下方用户名和后缀创建分裂邮箱；两项留空才随机分配';
  create.addEventListener('click', () => {
    createMailComSplitAlias(account, input, domain);
  });
  const createAndStart = document.createElement('button');
  createAndStart.type = 'button';
  createAndStart.textContent = accountBusy ? '处理中…' : '创建并启动';
  createAndStart.className = 'primary-mini';
  createAndStart.disabled = accountBusy || !sessionReady;
  createAndStart.title = createAndStart.disabled
    ? '先打开后台会话，再创建分裂邮箱并启动注册任务'
    : '从隐藏后缀随机创建一个分裂邮箱并立即启动注册任务';
  createAndStart.addEventListener('click', () => createAndStartMailComTask(account));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '删除主号';
  remove.className = 'danger-mini';
  remove.addEventListener('click', () => deleteMailComSplitAccount(account));
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '关闭会话';
  close.className = 'danger-mini';
  close.hidden = !sessionReady;
  close.addEventListener('click', () => closeMailComSplitSession(account));
  actions.append(open, create, createAndStart, close, remove);
  header.append(identity, actions);
  const body = document.createElement('div');
  body.className = 'split-account-body';
  const accountFeedback = document.createElement('div');
  accountFeedback.className = 'inline-status';
  accountFeedback.textContent = state.mailComAccountFeedbacks?.[account.id] || '';
  accountFeedback.hidden = !accountFeedback.textContent;
  const form = document.createElement('div');
  form.className = 'split-alias-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '用户名或完整分裂邮箱；留空随机';
  input.value = state.mailComAliasDrafts[account.id] || '';
  input.addEventListener('input', () => {
    state.mailComAliasDrafts = { ...state.mailComAliasDrafts, [account.id]: input.value };
  });
  const domain = document.createElement('input');
  domain.type = 'text';
  domain.className = 'mail-com-alias-domain-input';
  domain.setAttribute('list', 'mailComSharedDomainOptions');
  domain.placeholder = '后缀，例如 missouri.usa.com；留空随机';
  const savedDomain = normalizeDomain(state.mailComAliasDomains[account.id]);
  domain.value = isMailComSplitDomainAllowed(savedDomain) ? savedDomain : '';
  domain.addEventListener('input', () => {
    state.mailComAliasDomains = { ...state.mailComAliasDomains, [account.id]: domain.value };
    localStorage.setItem('mailComAliasDomains', JSON.stringify(state.mailComAliasDomains));
  });
  form.append(input, domain);
  const aliasList = document.createElement('div');
  aliasList.className = 'split-alias-list';
  if (aliases.length) {
    for (const alias of aliases) aliasList.append(renderMailComSplitAlias(account, alias));
  } else {
    aliasList.append(item({ title: '暂无分裂邮箱', meta: sessionReady ? '点击“创建分裂邮箱”后会显示在这里' : '先打开后台会话，再创建分裂邮箱' }));
  }
  body.append(accountFeedback, form, aliasList);
  node.append(header, body);
  return node;
}

function renderMailComSplitAccount(account) {
  const node = document.createElement('article');
  node.className = 'split-account';
  node.dataset.mailComAccountId = account.id;
  const collapsed = state.collapsedMailComAccountIds.has(account.id);
  node.classList.toggle('is-collapsed', collapsed);
  const header = document.createElement('div');
  header.className = 'split-account-header';
  const identity = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = account.email;
  const meta = document.createElement('code');
  const aliases = Array.isArray(account.aliases) ? account.aliases : [];
  const historicalAliasCount = Math.max(aliases.length, Number(account.historicalAliasCount || 0));
  const sessionOverride = state.mailComSessionOverrides?.[account.id] || {};
  const session = { ...(account.session || {}), ...sessionOverride };
  const sessionReady = mailComSessionReady(session);
  const sessionText = session.status === 'opening'
    ? '会话打开中…'
    : sessionReady
      ? '会话已打开'
      : session.status === 'failed'
        ? `会话打开失败${session.lastError ? `：${session.lastError}` : ''}`
        : '会话未打开';
  const domainCount = Number(account.domainCount || account.availableDomains?.length || 0);
  const domainText = domainCount
    ? ` · 后缀 ${domainCount}（当前 ${Number(account.activeDomainCount || 0)} / 隐藏 ${Number(account.hiddenDomainCount || 0)}）`
    : mailComSharedDomains().length
      ? ` · 使用共享后缀 ${mailComSharedDomains().length}`
      : ' · 后缀未同步';
  meta.textContent = `${sessionText} · 当前 ${aliases.length}/9 · 历史记录 ${historicalAliasCount} 条（含失败预留）${domainText}`;
  identity.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'split-account-actions';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = collapsed ? '展开' : '折叠';
  toggle.className = 'primary-mini';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.addEventListener('click', () => {
    if (collapsed) state.collapsedMailComAccountIds.delete(account.id);
    else state.collapsedMailComAccountIds.add(account.id);
    localStorage.setItem('collapsedMailComAccountIds', JSON.stringify([...state.collapsedMailComAccountIds]));
    renderMailComSplitAccounts();
  });
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = session.status === 'opening' ? '打开中…' : (sessionReady ? '重开会话' : '打开后台会话');
  open.className = 'primary-mini';
  open.disabled = session.status === 'opening';
  open.addEventListener('click', () => openMailComSplitSession(account));
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '关闭会话';
  close.className = 'danger-mini';
  close.hidden = !sessionReady;
  close.addEventListener('click', () => closeMailComSplitSession(account));
  const sync = document.createElement('button');
  sync.type = 'button';
  sync.textContent = '同步邮箱';
  sync.className = 'primary-mini';
  sync.addEventListener('click', () => syncMailComSplitAliases(account));
  const createQuick = document.createElement('button');
  createQuick.type = 'button';
  createQuick.textContent = '创建分裂邮箱';
  createQuick.className = 'primary-mini';
  createQuick.disabled = !sessionReady;
  createQuick.title = createQuick.disabled ? '先打开后台会话，再创建分裂邮箱' : '使用下方输入框或默认后缀创建一个新的分裂邮箱';
  createQuick.addEventListener('click', () => {
    if (collapsed) {
      state.collapsedMailComAccountIds.delete(account.id);
      localStorage.setItem('collapsedMailComAccountIds', JSON.stringify([...state.collapsedMailComAccountIds]));
      renderMailComSplitAccounts();
      return;
    }
    const formNode = node.querySelector('.split-alias-form');
    const inputNode = formNode?.querySelector('input');
    const domainNode = formNode?.querySelector('.mail-com-alias-domain-input');
    createMailComSplitAlias(account, inputNode, domainNode);
  });
  const autoStart = document.createElement('button');
  const accountBusy = state.mailComBusyAccountIds.has(account.id);
  autoStart.type = 'button';
  autoStart.textContent = accountBusy ? '创建/排队中…' : '创建并加入注册队列';
  autoStart.className = 'primary-mini';
  autoStart.title = '只使用已经开启的主邮箱会话创建分裂邮箱，并把新号加入注册任务池；不会自动打开其他会话';
  autoStart.disabled = accountBusy || !state.mailComAccounts.some((item) => mailComSessionReady(item.session));
  autoStart.addEventListener('click', () => startMailComAutoTasks(account));
  const syncDomains = document.createElement('button');
  syncDomains.type = 'button';
  syncDomains.textContent = '同步后缀';
  syncDomains.className = 'primary-mini';
  syncDomains.addEventListener('click', () => syncMailComSplitDomains(account));
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = '清空邮件';
  clear.className = 'danger-mini';
  clear.addEventListener('click', () => clearMailComSplitInbox(account));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '删除主号';
  remove.className = 'danger-mini';
  remove.addEventListener('click', () => deleteMailComSplitAccount(account));
  actions.append(toggle, open, close, createQuick, autoStart, sync, syncDomains, clear, remove);
  header.append(identity, actions);

  const form = document.createElement('div');
  form.className = 'split-alias-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '用户名或完整分裂邮箱；留空随机';
  input.value = state.mailComAliasDrafts[account.id] || '';
  input.addEventListener('input', () => {
    state.mailComAliasDrafts = { ...state.mailComAliasDrafts, [account.id]: input.value };
  });
  const domain = document.createElement('input');
  domain.type = 'text';
  domain.className = 'mail-com-alias-domain-input';
  domain.setAttribute('list', 'mailComSharedDomainOptions');
  domain.placeholder = '后缀，例如 secretary.net';
  const savedDomain = normalizeDomain(state.mailComAliasDomains[account.id]);
  const rememberedDomain = isMailComSplitDomainAllowed(savedDomain) ? savedDomain : '';
  domain.value = rememberedDomain;
  domain.placeholder = '留空则从隐藏后缀随机选择';
  if (!Array.isArray(account.availableDomains) || !account.availableDomains.length) {
    domain.title = mailComSharedDomains().length
      ? `可直接使用共享后缀表中的 ${mailComSharedDomains().length} 个后缀`
      : '先点击“同步后缀”获取并保存后缀表';
  }
  domain.addEventListener('input', () => {
    state.mailComAliasDomains = { ...state.mailComAliasDomains, [account.id]: domain.value };
    localStorage.setItem('mailComAliasDomains', JSON.stringify(state.mailComAliasDomains));
  });
  const create = document.createElement('button');
  create.type = 'button';
  create.textContent = '创建分裂邮箱';
  create.className = 'primary-mini';
  create.addEventListener('click', () => createMailComSplitAlias(account, input, domain));
  form.append(input, domain, create);

  const aliasList = document.createElement('div');
  aliasList.className = 'split-alias-list';
  if (!aliases.length) {
    aliasList.append(item({ title: '暂无分裂邮箱', meta: '创建后会显示在这里' }));
  } else {
    for (const alias of aliases) aliasList.append(renderMailComSplitAlias(account, alias));
  }

  const body = document.createElement('div');
  body.className = 'split-account-body';
  const accountFeedback = document.createElement('div');
  accountFeedback.className = 'inline-status';
  accountFeedback.textContent = state.mailComAccountFeedbacks?.[account.id] || '';
  accountFeedback.hidden = !accountFeedback.textContent;
  body.append(accountFeedback, form, aliasList);
  node.append(header, body);
  return node;
}

function renderMailComDomainLookup() {
  const container = $('mailComDomainLookup');
  if (!container) return;
  const available = mailComSharedDomains();
  const signature = JSON.stringify({
    available: available.map((entry) => [entry.domain, entry.state, entry.blacklisted, entry.consecutiveOtpTimeoutTasks]),
  });
  if (signature === state.mailComDomainSignature) return;
  state.mailComDomainSignature = signature;
  const previousLists = container.querySelectorAll('.mail-com-domain-group .mail-com-domain-list');
  const scrollPositions = {
    active: previousLists[0]?.scrollTop || 0,
    hidden: previousLists[1]?.scrollTop || 0,
    blacklisted: previousLists[2]?.scrollTop || 0,
    noTrialBlacklisted: previousLists[3]?.scrollTop || 0,
  };
  const previousSearch = container.querySelector('input[type="search"]')?.value || '';
  const blacklisted = available.filter((entry) => entry.noCodeBlacklisted ?? entry.blacklisted);
  const noTrialBlacklisted = available.filter((entry) => entry.noTrialBlacklisted);
  const active = available.filter((entry) => entry.state === 'ACTIVE' && !(entry.noCodeBlacklisted ?? entry.blacklisted) && !entry.noTrialBlacklisted);
  const hidden = available.filter((entry) => entry.state !== 'ACTIVE' && !(entry.noCodeBlacklisted ?? entry.blacklisted) && !entry.noTrialBlacklisted);
  const section = document.createElement('section');
  section.className = 'mail-com-domain-table';
  const heading = document.createElement('div');
  heading.className = 'mail-com-domain-table-heading';
  const title = document.createElement('strong');
  title.textContent = '后缀表';
  const count = document.createElement('span');
  count.className = 'field-hint';
  count.textContent = available.length
    ? `显式 ${active.length} · 隐藏 ${hidden.length} · 无验证码 ${blacklisted.length} · 无试用 ${noTrialBlacklisted.length}`
    : '尚未同步主邮箱后缀';
  const fetch = document.createElement('button');
  fetch.type = 'button';
  fetch.className = 'primary-mini';
  fetch.textContent = '获取后缀';
  fetch.title = '手动调用接口并保存后缀列表';
  fetch.addEventListener('click', () => syncAllMailComDomains(fetch));
  heading.append(title, count, fetch);
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '查找后缀';
  search.value = previousSearch;
  search.setAttribute('aria-label', '查找后缀');
  const groups = document.createElement('div');
  groups.className = 'mail-com-domain-groups';

  const renderGroup = (label, entries, className) => {
    const group = document.createElement('div');
    group.className = `mail-com-domain-group ${className}`;
    const groupTitle = document.createElement('span');
    groupTitle.className = 'mail-com-domain-group-title';
    groupTitle.textContent = `${label} (${entries.length})`;
    const list = document.createElement('div');
    list.className = 'mail-com-domain-list';
    for (const entry of entries) {
      const domain = document.createElement('code');
      domain.className = 'mail-com-domain-item';
      domain.dataset.domain = entry.domain;
      domain.textContent = entry.domain;
      list.append(domain);
    }
    if (!entries.length) list.append(item({ title: '暂无后缀', meta: '点击“同步后缀”获取' }));
    group.append(groupTitle, list);
    groups.append(group);
  };
  renderGroup('显示后缀', active, 'active');
  renderGroup('隐藏后缀', hidden, 'hidden');
  renderGroup('无验证码黑名单（连续两个独立任务未收到验证码）', blacklisted, 'blacklisted');
  renderGroup('无试用黑名单（连续三个独立任务无试用资格）', noTrialBlacklisted, 'no-trial-blacklisted');
  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase();
    for (const domain of groups.querySelectorAll('.mail-com-domain-item')) {
      domain.hidden = Boolean(query && !domain.dataset.domain.includes(query));
    }
  });
  if (previousSearch) search.dispatchEvent(new Event('input'));
  section.append(heading, search, groups);
  container.replaceChildren(section);
  const nextLists = container.querySelectorAll('.mail-com-domain-group .mail-com-domain-list');
  if (nextLists[0]) nextLists[0].scrollTop = scrollPositions.active;
  if (nextLists[1]) nextLists[1].scrollTop = scrollPositions.hidden;
  if (nextLists[2]) nextLists[2].scrollTop = scrollPositions.blacklisted;
  if (nextLists[3]) nextLists[3].scrollTop = scrollPositions.noTrialBlacklisted;
}

async function syncAllMailComDomains(button) {
  const accounts = Array.isArray(state.mailComAccounts) ? state.mailComAccounts : [];
  if (!accounts.length) {
    setMailComFeedback('请先导入主邮箱');
    return;
  }
  button.disabled = true;
  setMailComFeedback(`正在获取 ${accounts.length} 个主邮箱的后缀…`);
  const failures = [];
  try {
    for (const account of accounts) {
      try {
        await api.post(`/api/mailbox/mail-com-split/accounts/${encodeURIComponent(account.id)}/domains/sync`, {});
      } catch (error) {
        failures.push(`${account.email}: ${error.message}`);
      }
    }
    await refresh({ silent: true });
    setMailComFeedback(failures.length
      ? `部分后缀同步失败：失败账号已保留上一次后缀（${failures.length}/${accounts.length}）`
      : `后缀已获取并保存：${accounts.length} 个主邮箱`);
  } finally {
    button.disabled = false;
  }
}

function renderMailComSplitAlias(account, alias) {
  const node = document.createElement('div');
  node.className = 'split-alias-item';
  const left = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = alias;
  const meta = document.createElement('code');
  meta.textContent = `主号 · ${account.email}`;
  left.append(title, meta);
  const actions = document.createElement('div');
  actions.className = 'item-actions';
  const code = document.createElement('button');
  code.type = 'button';
  code.textContent = '取码';
  code.className = 'primary-mini';
  code.addEventListener('click', () => fetchMailComSplitCode(account, alias));
  const start = document.createElement('button');
  const sessionOverride = state.mailComSessionOverrides?.[account.id] || {};
  const sessionReady = mailComSessionReady({ ...(account.session || {}), ...sessionOverride });
  start.type = 'button';
  start.textContent = '启动';
  start.className = 'primary-mini';
  start.disabled = !sessionReady || state.activeTaskStarts.has(String(alias || '').toLowerCase());
  start.title = sessionReady ? '启动这个分裂邮箱的注册任务' : '等待主邮箱会话查询和残留分裂邮箱清理完成';
  start.addEventListener('click', () => startTaskForEmail({
    email: alias,
    mailboxSource: 'mail_com_split',
  }));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = '删除';
  remove.className = 'danger-mini';
  remove.addEventListener('click', () => deleteMailComSplitAlias(account, alias));
  actions.append(start, code, remove);
  node.append(left, actions);
  return node;
}

function setMailComFeedback(message) {
  state.lastMailComAutoStart = null;
  state.mailComFeedbackMessage = String(message || '');
  for (const id of ['mailComSplitFeedback', 'mailComRunFeedback']) {
    if ($(id)) $(id).textContent = state.mailComFeedbackMessage;
  }
}

function setMailComAccountFeedback(account, message) {
  if (!account?.id) return;
  state.mailComAccountFeedbacks = {
    ...(state.mailComAccountFeedbacks || {}),
    [account.id]: String(message || ''),
  };
}

function mailComRegistrationRuntimeStats() {
  const config = state.config?.registration?.autoStart || {};
  const runtime = config.runtime || {};
  const target = Number(runtime.target || config.mailComReserveTarget || 9);
  const concurrency = Number(runtime.concurrency || config.concurrency || 3);
  const fallbackReady = (state.emails || []).filter((entry) => entry.status === 'ready').length;
  const registrationSummary = state.registrationView?.summary || {};
  const running = Number(registrationSummary.running ?? runtime.running ?? 0);
  const reserved = Number(runtime.reservedSlots || 0);
  const executing = running + reserved;
  const waiting = Number((Number(registrationSummary.queued || 0) + Number(registrationSummary.waiting_mail || 0)) || runtime.queued || 0);
  const ready = Number.isFinite(Number(runtime.ready)) ? Number(runtime.ready) : fallbackReady;
  const autoEnabled = runtime.autoEnabled ?? config.enabled === true;
  return { target, concurrency, running, reserved, executing, waiting, ready, autoEnabled, runtime };
}

function renderMailComAutoStartLiveFeedback() {
  const stats = mailComRegistrationRuntimeStats();
  const reservedText = stats.reserved ? ` · 创建中 ${stats.reserved}` : '';
  const autoText = stats.autoEnabled ? '自动取号开' : '自动取号关';
  const summaryText = `全局注册：${autoText} · 执行中 ${stats.executing}/${stats.concurrency}${reservedText} · 排队 ${stats.waiting} · 待取 ${stats.ready} · mail储备目标 ${stats.target}`;
  if ($('registrationAutoStartPoolSummary')) $('registrationAutoStartPoolSummary').textContent = summaryText;
  const auto = state.lastMailComAutoStart;
  if (!auto || !$('mailComRunFeedback')) return;
  const created = Array.isArray(auto.created) ? auto.created.length : 0;
  const started = Array.isArray(auto.started) ? auto.started.length : 0;
  $('mailComRunFeedback').textContent = `${summaryText} · 本次新建 ${created} · 本次启动 ${started}`;
}

function mergeMailComSplitAccountResult(result) {
  const account = result?.account;
  if (!account?.id) return false;
  const nextAccount = {
    ...account,
    session: result.session || account.session,
  };
  let replaced = false;
  state.mailComAccounts = (Array.isArray(state.mailComAccounts) ? state.mailComAccounts : []).map((item) => {
    if (item.id !== nextAccount.id) return item;
    replaced = true;
    return { ...item, ...nextAccount };
  });
  if (!replaced) state.mailComAccounts.push(nextAccount);
  renderMailComSplitAccounts();
  return true;
}

async function openMailComSplitSession(account) {
  if (!account?.id) return;
  state.mailComSessionOverrides = {
    ...(state.mailComSessionOverrides || {}),
    [account.id]: { status: 'opening', open: false, lastError: '', openingAt: new Date().toISOString() },
  };
  setMailComAccountFeedback(account, `正在打开会话并核对、清理残留分裂邮箱：${account.email}`);
  setMailComFeedback(`正在打开会话并核对、清理残留分裂邮箱：${account.email}`);
  renderMailComSplitAccounts();
  try {
    const result = await api.post(`/api/mailbox/mail-com-split/accounts/${encodeURIComponent(account.id)}/session/open`, {
      headed: false,
      ...mailComAutoTaskBody(account),
    });
    delete state.mailComSessionOverrides[account.id];
    mergeMailComSplitAccountResult(result);
    await refresh({ silent: true }).catch(() => {});
    const count = Number(result?.observed?.aliases?.length || 0);
    setMailComAccountFeedback(account, `会话已就绪，远端确认 ${count} 个分裂邮箱：${account.email}`);
    setMailComFeedback(`会话已就绪，远端确认 ${count} 个分裂邮箱：${account.email}`);
  } catch (error) {
    state.mailComSessionOverrides = {
      ...(state.mailComSessionOverrides || {}),
      [account.id]: { status: 'failed', open: false, lastError: String(error.message || error), failedAt: new Date().toISOString() },
    };
    setMailComAccountFeedback(account, `打开后台会话失败：${error.message}`);
    setMailComFeedback(`打开后台会话失败：${error.message}`);
    renderMailComSplitAccounts();
  }
}

async function closeMailComSplitSession(account) {
  if (!account?.id) return;
  setMailComFeedback(`正在关闭主邮箱后台会话：${account.email}`);
  try {
    const result = await api.post(`/api/mailbox/mail-com-split/accounts/${encodeURIComponent(account.id)}/session/close`, {});
    mergeMailComSplitAccountResult(result);
    await refresh({ silent: true }).catch(() => {});
    setMailComFeedback(`后台会话已关闭：${account.email}`);
  } catch (error) {
    setMailComFeedback(`关闭后台会话失败：${error.message}`);
  }
}

function mailComAutoStartSummary(result, account) {
  const auto = result?.autoStart || {};
  const registrationListCount = Number(auto.registrationListCount ?? 0);
  const target = Number(auto.target || state.config?.registration?.autoStart?.mailComReserveTarget || 9);
  const created = Array.isArray(auto.created) ? auto.created.length : 0;
  const started = Array.isArray(auto.started) ? auto.started.length : 0;
  const failures = Array.isArray(auto.failures) ? auto.failures.length : 0;
  const reassignedConflicts = Array.isArray(auto.reassignedConflicts) ? auto.reassignedConflicts.length : 0;
  const retryText = reassignedConflicts ? ` · 409 后保留地址并换主邮箱 ${reassignedConflicts} 次` : '';
  if (auto.status === 'failed') return `自动创建失败：${auto.error || '未知错误'}`;
  if (auto.status === 'session_required') return `请先登录这个主邮箱 · 全局 ${registrationListCount}/${target}`;
  if (auto.status === 'already_running') return `此邮箱任务正在运行 · 全局 ${registrationListCount}/${target}`;
  if (failures) {
    const firstError = auto.failures?.[0]?.error === 'no_user_opened_mail_com_sessions'
      ? '没有已开启的主邮箱会话'
      : auto.failures?.[0]?.error || '未知错误';
    return `全局 ${registrationListCount}/${target} · 新建 ${created} · 启动 ${started}${retryText} · ${failures} 个失败：${firstError}`;
  }
  return `全局 ${registrationListCount}/${target} · 新建 ${created} · 启动 ${started}${retryText}`;
}

function mailComAutoTaskBody(account) {
  const aliasDraft = account?.id ? String(state.mailComAliasDrafts?.[account.id] || '').trim() : '';
  const usernamePrefix = aliasDraft && !aliasDraft.includes('@') ? aliasDraft : '';
  return {
    ...(usernamePrefix ? { usernamePrefix } : {}),
    proxyPoolId: proxyPoolPayload('main'),
    ...registrationExecutionPayload(),
  };
}

async function createAndStartMailComTask(account) {
  if (!account?.id || state.mailComBusyAccountIds.has(account.id)) return;
  state.mailComBusyAccountIds.add(account.id);
  setMailComAccountFeedback(account, '正在随机创建分裂邮箱并启动注册任务…');
  renderMailComSplitAccounts();
  try {
    await uiPreferenceSaveQueue;
    const result = await api.post('/api/tasks/mail-com-split', {
      accountId: account.id,
      ...mailComAutoTaskBody(account),
    });
    if (result?.task?.id) state.expandedTaskIds.add(result.task.id);
    await refresh({ silent: true, all: true });
    const taskStatus = String(result?.task?.status || 'queued').trim().toLowerCase();
    setMailComAccountFeedback(account, `已创建注册任务：${result.email} · 当前状态 ${taskStatus}`);
    setMailComFeedback(`已创建并启动：${result.email} · 当前状态 ${taskStatus}`);
    setTab('run');
  } catch (error) {
    setMailComAccountFeedback(account, `创建并启动失败：${error.message}`);
    setMailComFeedback(`创建并启动失败：${error.message}`);
  } finally {
    state.mailComBusyAccountIds.delete(account.id);
    renderMailComSplitAccounts();
  }
}

async function startMailComAutoTasks(account) {
  if (!account?.id) return;
  const runningText = `正在创建并加入注册队列：只使用已开启会话，从 ${account.email} 开始按顺序处理…`;
  state.mailComBusyAccountIds.add(account.id);
  setMailComAccountFeedback(account, runningText);
  setMailComFeedback(runningText);
  renderMailComSplitAccounts();
  try {
    const result = await api.post('/api/mailbox/mail-com-split/accounts/autostart', {
      accountId: account.id,
      ...mailComAutoTaskBody(account),
    });
    await refresh({ silent: true });
    state.lastMailComAutoStart = result.result || null;
    const summary = mailComAutoStartSummary({ autoStart: state.lastMailComAutoStart }, account);
    setMailComAccountFeedback(account, summary);
    setMailComFeedback(summary);
    renderMailComAutoStartLiveFeedback();
  } catch (error) {
    const message = `创建此邮箱任务失败：${error.message}`;
    setMailComAccountFeedback(account, message);
    setMailComFeedback(message);
  } finally {
    state.mailComBusyAccountIds.delete(account.id);
    renderMailComSplitAccounts();
  }
}

async function syncMailComSplitAliases(account) {
  if (!account?.id) return;
  setMailComFeedback(`正在同步分裂邮箱：${account.email}`);
  try {
    const result = await api.post(
      `/api/mailbox/mail-com-split/accounts/${encodeURIComponent(account.id)}/aliases/sync`,
      mailComAutoTaskBody(account),
    );
    await refresh({ silent: true });
    setMailComFeedback(`已同步 ${result.syncedAliases?.length ?? result.aliases?.length ?? 0} 个分裂邮箱：${account.email} · ${mailComAutoStartSummary(result, account)}`);
  } catch (error) {
    setMailComFeedback(`同步失败：${error.message}`);
  }
}

async function syncMailComSplitDomains(account) {
  if (!account?.id) return;
  setMailComFeedback(`正在同步完整后缀：${account.email}`);
  try {
    const result = await api.post(`/api/mailbox/mail-com-split/accounts/${encodeURIComponent(account.id)}/domains/sync`, {});
    await refresh({ silent: true });
    const synced = result.account || {};
    setMailComFeedback(
      `已同步 ${synced.domainCount || 0} 个后缀：当前 ${synced.activeDomainCount || 0} 个，隐藏 ${synced.hiddenDomainCount || 0} 个`,
    );
  } catch (error) {
    setMailComFeedback(`后缀同步失败：${error.message}`);
  }
}

async function clearMailComSplitInbox(account) {
  if (!account?.id) return;
  setMailComFeedback(`正在清空邮件：${account.email}`);
  try {
    const result = await api.post(`/api/mailbox/mail-com-split/accounts/${encodeURIComponent(account.id)}/mail/clear-inbox`, {});
    await refresh({ silent: true });
    setMailComFeedback(`已清空邮件：${result.deleted || 0} 封`);
  } catch (error) {
    setMailComFeedback(`清空失败：${error.message}`);
  }
}

async function deleteMailComSplitAccount(account) {
  if (!account?.id) return;
  setMailComFeedback(`正在删除主邮箱：${account.email}`);
  try {
    await api.delete(`/api/mailbox/mail-com-split/accounts/${encodeURIComponent(account.id)}`);
    await refresh({ silent: true });
    setMailComFeedback(`已删除主邮箱：${account.email}`);
  } catch (error) {
    setMailComFeedback(`删除失败：${error.message}`);
  }
}

async function createMailComSplitAlias(account, input, domainInput) {
  if (!account?.id) return;
  const value = String(input?.value || '').trim();
  const domain = normalizeDomain(domainInput?.value || '');
  const requestedDomain = value.includes('@') ? emailDomain(value) : domain;
  if (requestedDomain && !isMailComSplitDomainAllowed(requestedDomain)) {
    setMailComFeedback('mail.com 不支持删除，不能用作分裂邮箱后缀。');
    return;
  }
  if (account?.id && domainInput && domain) {
    state.mailComAliasDomains = { ...state.mailComAliasDomains, [account.id]: domain };
    localStorage.setItem('mailComAliasDomains', JSON.stringify(state.mailComAliasDomains));
  }
  const isFullEmail = value.includes('@');
  setMailComFeedback(value
    ? `正在创建分裂邮箱：${isFullEmail ? value : `${value}@${domain || '未填后缀'}`}`
    : `正在自动生成分裂邮箱：${account.email}`);
  try {
    const result = await api.post(`/api/mailbox/mail-com-split/accounts/${encodeURIComponent(account.id)}/aliases`, {
      email: isFullEmail ? value : undefined,
      localPart: !isFullEmail && value ? value : undefined,
      domain: !isFullEmail ? domain : undefined,
    });
    state.mailComAliasDrafts = { ...state.mailComAliasDrafts, [account.id]: '' };
    if (input) input.value = '';
    await refresh({ silent: true });
    setMailComFeedback(`已创建分裂邮箱：${result.alias}`);
  } catch (error) {
    await refresh({ silent: true }).catch(() => {});
    setMailComFeedback(`创建失败：${error.message}`);
  }
}

async function deleteMailComSplitAlias(account, alias) {
  if (!account?.id || !alias) return;
  setMailComFeedback(`正在删除分裂邮箱：${alias}`);
  try {
    await api.delete(`/api/mailbox/mail-com-split/accounts/${encodeURIComponent(account.id)}/aliases/${encodeURIComponent(alias)}`);
    await refresh({ silent: true });
    setMailComFeedback(`已删除分裂邮箱：${alias}`);
  } catch (error) {
    setMailComFeedback(`删除失败：${error.message}`);
  }
}

async function fetchMailComSplitCode(account, alias) {
  if (!account?.id || !alias) return;
  suspendAutoRefresh(15000);
  setMailComFeedback(`正在取码：${alias}`);
  try {
    const result = await api.post(`/api/mailbox/mail-com-split/accounts/${encodeURIComponent(account.id)}/aliases/${encodeURIComponent(alias)}/code`, {});
    const code = result?.code || result?.otpCode || '';
    if (code) {
      suspendAutoRefresh(8000);
      try {
        await copyTextToClipboard(code);
        setMailComFeedback(`已复制验证码：${alias} · ${code}`);
      } catch (copyError) {
        setMailComFeedback(`已取到验证码但复制被拦截：${alias} · ${code}`);
      }
      return;
    }
    setMailComFeedback(`未取到验证码：${result?.reason || 'unknown'}`);
  } catch (error) {
    setMailComFeedback(`取码失败：${error.message}`);
  }
}

for (const button of document.querySelectorAll('[data-tab]')) {
  button.addEventListener('click', () => {
    setTab(button.dataset.tab);
    refresh({ silent: true, lightweight: true }).catch(() => {});
    if (button.dataset.tab === 'refining' && !state.refiningCapabilities) testRefiningService();
  });
}

for (const button of document.querySelectorAll('[data-mail-category]')) {
  button.addEventListener('click', () => setMailCategory(button.dataset.mailCategory));
}

for (const button of document.querySelectorAll('[data-run-category]')) {
  button.addEventListener('click', () => setRunCategory(button.dataset.runCategory));
}

for (const button of document.querySelectorAll('[data-mail-workflow-stage]')) {
  button.addEventListener('click', () => setMailWorkflowStage(button.dataset.mailWorkflowStage));
}
for (const button of document.querySelectorAll('[data-sold-substage]')) {
  button.addEventListener('click', () => {
    state.soldWorkflowSubstage = button.dataset.soldSubstage === 'sms' ? 'sms' : 'unsms';
    localStorage.setItem('soldWorkflowSubstage', state.soldWorkflowSubstage);
    state.selectedWorkflowEmails.clear();
    renderEmailRunStatus();
  });
}
$('runWorkflowStageAction')?.addEventListener('click', runCurrentWorkflowStageAction);

$('selectVisibleWorkflowRows')?.addEventListener('change', (event) => {
  const checked = Boolean(event.target.checked);
  const renderedRows = [...document.querySelectorAll('[data-run-panel]:not([hidden]) .email-status-row[data-email]')]
    .filter((row) => row.offsetParent !== null)
    .map((row) => row.dataset.email);
  const targetEmails = renderedRows.length
    ? renderedRows
    : (state.visibleMailWorkflowRows || []).map((row) => normalizeEmailKey(row?.entry?.email));
  for (const key of targetEmails) {
    if (!key) continue;
    if (checked) state.selectedWorkflowEmails.add(key);
    else state.selectedWorkflowEmails.delete(key);
  }
  renderEmailRunStatus();
});
$('checkSelectedWorkflowAtLive')?.addEventListener('click', checkSelectedWorkflowAccessTokensLive);
$('mailWorkflowRefiningFilter')?.addEventListener('input', (event) => {
  state.mailWorkflowRefiningQuery = String(event.target.value || '');
  localStorage.setItem('mailWorkflowRefiningQuery', state.mailWorkflowRefiningQuery);
  state.selectedWorkflowEmails.clear();
  renderEmailRunStatus();
});
for (const input of document.querySelectorAll('.refining-config-panel input, .refining-config-panel select, .refining-config-panel textarea')) {
  input.addEventListener('input', () => { state.refiningDraftDirty = true; });
  input.addEventListener('change', () => { state.refiningDraftDirty = true; });
}

bindSettingsDraftDirty([
  'registrationSetupPassword',
  'registrationAutoCheckEligibility',
  'registrationSetupTotp2fa',
  'registrationValidateOauthSession',
  'registrationPhoneBindProbeEnabled',
  'registrationChangeEmailBaseUrl',
  'registrationChangeEmailApiToken',
  'registrationChangeEmailDomain',
  'registrationChangeEmailLocalPartPrefix',
  'registrationChangeEmailTimeoutSeconds',
  'registrationChangeEmailPollIntervalMs',
  'registrationPostRegistrationDelaySeconds',
  'registrationChangeEmailEnabled',
  'registrationChangeEmailFailRegistrationOnError',
], 'registrationChangeEmailDraftDirty');

bindSettingsDraftDirty([
  'paymentServiceBaseUrl',
  'paymentProxyPoolSelect',
  'paymentSmsApiKey',
  'paymentSmsCountry',
  'paymentSmsPriceMin',
  'paymentSmsPriceMax',
  'paymentSmsTimeoutSeconds',
  'paymentSmsMaxAttempts',
  'paymentPollIntervalMs',
  'paymentSmsPhoneRetryLimit',
  'paymentTaskRetryLimit',
  'paymentSmsProviderRank',
  'paymentEnabled',
], 'paymentDraftDirty');

bindSettingsDraftDirty([
  'paymentMethodProbeProxyPool',
], 'paymentMethodProbeDraftDirty');

bindSettingsDraftDirty([
  'phoneBindSub2BaseUrl',
  'phoneBindSub2AdminApiKey',
  'phoneBindSmsApiKey',
  'phoneBindSmsCountrySearch',
  'phoneBindSmsCountries',
  'phoneBindSmsPriceMin',
  'phoneBindSmsPriceMax',
  'phoneBindSmsTimeoutSeconds',
  'phoneBindSmsMaxAttempts',
  'phoneBindSmsPhoneRetryLimit',
  'phoneBindSmsProviderRank',
  'phoneBindAutoEnabled',
], 'phoneBindSettingsDraftDirty');

$('refiningProvider').addEventListener('change', () => {
  syncRefiningConditionalFields();
});
$('refiningPlan').addEventListener('change', () => syncRefiningConditionalFields());
$('refiningLinkType').addEventListener('change', () => syncRefiningConditionalFields({ applyProviderDefault: true }));
$('refiningUsePromo').addEventListener('change', () => syncRefiningConditionalFields());
$('refiningRetryCount').addEventListener('input', () => syncRefiningConditionalFields());
$('refiningEntryProxyPool').addEventListener('change', () => syncRefiningConditionalFields());
$('refiningExitProxyPool').addEventListener('change', () => syncRefiningConditionalFields());
$('refiningCountry').addEventListener('change', () => {
  const currencies = state.refiningCapabilities?.country_currency || FALLBACK_COUNTRY_CURRENCY;
  $('refiningCurrency').value = currencies[$('refiningCountry').value] || 'USD';
});

$('testRefiningService').addEventListener('click', testRefiningService);
$('saveRefiningSettings').addEventListener('click', async () => {
  $('refiningFeedback').textContent = '正在保存提炼配置…';
  try {
    await api.put('/api/refining/settings', refiningSettingsPayload());
    state.refiningDraftDirty = false;
    await refresh({ silent: true });
    $('refiningFeedback').textContent = $('refiningEnabled')?.checked ? '提炼配置已保存；自动提炼已开启，会按当前线路补满空闲槽位。' : '提炼配置已保存；自动提炼未开启。';
  } catch (error) {
    $('refiningFeedback').textContent = `保存失败：${error.message}`;
  }
});

$('stopRefiningAutomation').addEventListener('click', async () => {
  $('refiningFeedback').textContent = '正在关闭自动提炼…';
  try {
    await api.post('/api/refining/automation/stop', {});
    state.refiningDraftDirty = false;
    await refresh({ silent: true });
    $('refiningFeedback').textContent = '自动提炼已关闭；不会再自动加入新账号，已在队列/运行中的任务会继续。';
  } catch (error) {
    $('refiningFeedback').textContent = `关闭自动提炼失败：${error.message}`;
  }
});

$('enqueueCurrentRefining').addEventListener('click', async () => {
  $('refiningFeedback').textContent = '正在加入当前合格账号…';
  try {
    const result = await api.post('/api/refining/enqueue-current', {});
    await refresh({ silent: true });
    $('refiningFeedback').textContent = `已加入 ${result.queued?.length || 0} 个账号，跳过 ${result.skipped?.length || 0} 个。`;
  } catch (error) {
    $('refiningFeedback').textContent = `加入失败：${error.message}`;
  }
});

$('cancelRefining').addEventListener('click', async () => {
  $('refiningFeedback').textContent = '正在停止运行批次…';
  try {
    const result = await api.post('/api/refining/cancel', {});
    await refresh({ silent: true });
    $('refiningFeedback').textContent = `已请求停止 ${result.cancelled || 0} 个批次。`;
  } catch (error) {
    $('refiningFeedback').textContent = `停止失败：${error.message}`;
  }
});


$('saveRegistrationChangeEmailSettings')?.addEventListener('click', async () => {
  $('registrationChangeEmailFeedback').textContent = '正在保存注册附加配置…';
  try {
    const body = {
      setupPassword: Boolean($('registrationSetupPassword').checked),
      setupTotp2fa: Boolean($('registrationSetupTotp2fa').checked),
      validateOauthSession: Boolean($('registrationValidateOauthSession')?.checked),
      autoCheckEligibility: Boolean($('registrationAutoCheckEligibility')?.checked),
      phoneBindProbeEnabled: Boolean($('registrationPhoneBindProbeEnabled')?.checked),
      enabled: Boolean($('registrationChangeEmailEnabled').checked),
      domainMailboxBaseUrl: $('registrationChangeEmailBaseUrl').value.trim(),
      domain: $('registrationChangeEmailDomain').value.trim(),
      localPartPrefix: $('registrationChangeEmailLocalPartPrefix').value.trim(),
      timeoutSeconds: Number($('registrationChangeEmailTimeoutSeconds').value || 120),
      pollIntervalMs: Number($('registrationChangeEmailPollIntervalMs')?.value || 3000),
      postRegistrationDelaySeconds: Number($('registrationPostRegistrationDelaySeconds')?.value || 0),
      failRegistrationOnError: Boolean($('registrationChangeEmailFailRegistrationOnError').checked),
    };
    const apiToken = $('registrationChangeEmailApiToken').value.trim();
    if (apiToken) body.domainMailboxApiToken = apiToken;
    state.registrationChangeEmailSettings = await api.put('/api/registration/change-email/settings', body);
    if (state.config?.registration) state.config.registration.changeEmail = state.registrationChangeEmailSettings;
    state.registrationChangeEmailDraftDirty = false;
    $('registrationChangeEmailApiToken').value = '';
    renderRegistrationChangeEmailSettings();
    $('registrationChangeEmailFeedback').textContent = '注册附加配置已保存；新任务会按这个配置执行。';
  } catch (error) {
    $('registrationChangeEmailFeedback').textContent = `保存失败：${error.message}`;
  }
});

$('mainProxyPoolSelect').addEventListener('change', (event) => {
  setSelectedProxyPool('main', event.target.value);
  renderProxyPools();
});

$('browserEngineSelect').addEventListener('change', (event) => {
  state.selectedBrowserEngine = event.target.selectedOptions?.[0]?.dataset?.key || '';
  localStorage.setItem('selectedBrowserEngine', state.selectedBrowserEngine);
  void persistUiPreferences();
  renderBrowserEngineSelect();
});

$('entryBranchSelect').addEventListener('change', (event) => {
  state.selectedEntryBranch = event.target.selectedOptions?.[0]?.dataset?.key || '';
  const implementation = executionImplementationItem(state.selectedEntryBranch);
  if (implementation) {
    state.selectedExecutionType = implementation.type;
    localStorage.setItem('selectedExecutionType', state.selectedExecutionType);
  }
  localStorage.setItem('selectedEntryBranch', state.selectedEntryBranch);
  void persistUiPreferences();
  renderEntryBranchSelect();
});

$('executionTypeSelect').addEventListener('change', (event) => {
  const type = executionTypeItem(event.target.value);
  if (!type) return;
  state.selectedExecutionType = type.key;
  localStorage.setItem('selectedExecutionType', state.selectedExecutionType);
  const current = executionImplementationItem(state.selectedEntryBranch);
  if (current?.type !== type.key) {
    state.selectedEntryBranch = implementationsForType(type.key)[0]?.key || '';
    localStorage.setItem('selectedEntryBranch', state.selectedEntryBranch);
  }
  void persistUiPreferences();
  renderEntryBranchSelect();
  renderBrowserEngineSelect();
});

$('cfDomains').addEventListener('change', (event) => {
  state.cfMailboxDraftDirty = true;
  state.cfMailbox = {
    ...(state.cfMailbox || {}),
    defaultDomain: normalizeDomain(event.target.value),
    domains: normalizeDomain(event.target.value) ? [normalizeDomain(event.target.value)] : [],
  };
  renderCloudflareMailboxConfig();
});

$('cfRandomSubdomain').addEventListener('change', (event) => {
  state.cfMailboxDraftDirty = true;
  state.cfMailbox = {
    ...(state.cfMailbox || {}),
    randomSubdomain: Boolean(event.target.checked),
  };
  renderCloudflareMailboxConfig();
});

$('mailComMainImport').addEventListener('input', (event) => {
  state.mailComDraft = { ...state.mailComDraft, mainImport: event.target.value };
});

function keepInputViewportStable(input) {
  if (!input) return;
  let topBeforeInput = null;
  input.addEventListener('beforeinput', () => {
    topBeforeInput = input.getBoundingClientRect().top;
  });
  input.addEventListener('input', () => {
    const expectedTop = topBeforeInput;
    topBeforeInput = null;
    if (!Number.isFinite(expectedTop)) return;
    requestAnimationFrame(() => {
      if (document.activeElement !== input) return;
      const topDelta = input.getBoundingClientRect().top - expectedTop;
      if (Math.abs(topDelta) > 1) window.scrollBy(0, topDelta);
    });
  });
}

keepInputViewportStable($('mailComReserveTarget'));
keepInputViewportStable($('registrationAutoStartConcurrency'));

$('mailComReserveTarget').addEventListener('input', (event) => {
  state.mailComDraft = { ...state.mailComDraft, autoStartTarget: event.target.value };
});
$('registrationAutoStartConcurrency').addEventListener('input', (event) => {
  state.mailComDraft = { ...state.mailComDraft, autoStartConcurrency: event.target.value };
});

$('importEmails').addEventListener('click', async () => {
  $('startFeedback').textContent = '正在导入邮箱…';
  await api.post('/api/emails/import', {
    emails: $('emailImport').value,
  });
  $('emailImport').value = '';
  await refresh();
  setTab('mail');
});

$('deleteSelectedEmails').addEventListener('click', async () => {
  const ids = [...state.selectedEmailIds];
  if (!ids.length) return;
  $('startFeedback').textContent = `正在删除 ${ids.length} 个已选邮箱…`;
  try {
    const result = await api.post('/api/emails/delete', { ids });
    state.selectedEmailIds.clear();
    await refresh({ silent: true });
    setTab('mail');
    $('startFeedback').textContent = `已删除 ${result.deleted} 个邮箱。`;
  } catch (error) {
    $('startFeedback').textContent = `批量删除失败：${error.message}`;
  }
});

$('saveCfMailbox').addEventListener('click', async () => {
  $('cfMailboxFeedback').textContent = '正在保存…';
  try {
    const selectedDomain = normalizeDomain($('cfDomains').value);
    const body = {
      baseUrl: $('cfBaseUrl').value,
      domains: selectedDomain,
      defaultDomain: selectedDomain,
      usernamePrefix: $('cfUsernamePrefix').value,
      randomSubdomain: Boolean($('cfRandomSubdomain').checked),
    };
    const adminAuth = $('cfAdminAuth').value.trim();
    if (adminAuth) body.adminAuth = adminAuth;
    state.cfMailbox = await api.put('/api/mailbox/cloudflare-temp-email/config', body);
    state.cfMailboxDraftDirty = false;
    $('cfAdminAuth').value = '';
    await refresh({ silent: true });
    setTab('mail');
    $('cfMailboxFeedback').textContent = '已保存。';
  } catch (error) {
    $('cfMailboxFeedback').textContent = `保存失败：${error.message}`;
  }
});

$('openMailComAliasManager')?.addEventListener('click', () => {
  openMailComAliasManager();
});

$('saveRegistrationAutoStartSettings')?.addEventListener('click', async () => {
  $('mailComSplitFeedback').textContent = '正在保存注册任务池设置…';
  try {
    const configBody = {
      mailComReserveTarget: Number(state.mailComDraft.autoStartTarget ?? $('mailComReserveTarget')?.value ?? 9),
      concurrency: Number(state.mailComDraft.autoStartConcurrency ?? $('registrationAutoStartConcurrency')?.value ?? 3),
    };
    state.config.registration = state.config.registration || {};
    state.config.registration.autoStart = await api.put('/api/registration/autostart/config', configBody);
    const nextDraft = { ...state.mailComDraft };
    delete nextDraft.autoStartTarget;
    delete nextDraft.autoStartConcurrency;
    state.mailComDraft = nextDraft;
    await refresh({ silent: true });
    setTab('mail');
    $('mailComSplitFeedback').textContent = '注册任务池设置已保存。';
  } catch (error) {
    $('mailComSplitFeedback').textContent = `保存失败：${error.message}`;
  }
});

$('savePaymentSettings').addEventListener('click', async () => {
  $('paymentSettingsFeedback').textContent = '正在保存支付配置…';
  try {
    const body = {
      enabled: Boolean($('paymentEnabled').checked),
      serviceBaseUrl: $('paymentServiceBaseUrl').value.trim(),
      smsCountry: $('paymentSmsCountry').value.trim(),
      smsPriceMin: Number($('paymentSmsPriceMin').value || 0),
      smsPriceMax: Number($('paymentSmsPriceMax').value || 0),
      smsTimeoutSeconds: Number($('paymentSmsTimeoutSeconds').value || 180),
      smsMaxAttempts: Number($('paymentSmsMaxAttempts').value || 12),
      pollIntervalMs: Number($('paymentPollIntervalMs')?.value || 3000),
      smsPhoneRetryLimit: Number($('paymentSmsPhoneRetryLimit').value || 0),
      paymentTaskRetryLimit: Number($('paymentTaskRetryLimit').value || 0),
      smsPreferGold: $('paymentSmsProviderRank').value === 'gold',
      proxyPoolId: $('paymentProxyPoolSelect').value === DIRECT_PROXY_VALUE ? '' : $('paymentProxyPoolSelect').value,
    };
    const apiKey = $('paymentSmsApiKey').value.trim();
    if (apiKey) body.smsApiKey = apiKey;
    state.paymentSettings = await api.put('/api/payment/settings', body);
    state.paymentDraftDirty = false;
    $('paymentSmsApiKey').value = '';
    renderPaymentSettings();
    $('paymentSettingsFeedback').textContent = '支付配置已保存；支付代理池与 checkout 独立。';
  } catch (error) {
    $('paymentSettingsFeedback').textContent = `保存失败：${error.message}`;
  }
});

$('savePaymentMethodProbeSettings')?.addEventListener('click', async () => {
  $('paymentMethodProbeFeedback').textContent = '正在保存支付方式检测配置…';
  try {
    const body = {
      proxyPoolId: $('paymentMethodProbeProxyPool').value === DIRECT_PROXY_VALUE ? '' : $('paymentMethodProbeProxyPool').value,
    };
    state.paymentMethodProbeSettings = await api.put('/api/payment-method-probe/settings', body);
    state.paymentMethodProbeDraftDirty = false;
    renderPaymentMethodProbeSettings();
    $('paymentMethodProbeFeedback').textContent = '支付方式检测配置已保存；注册完成后会按这个代理池必检。';
  } catch (error) {
    $('paymentMethodProbeFeedback').textContent = `保存失败：${error.message}`;
  }
});

$('phoneBindSmsCountrySearch').addEventListener('input', () => {
  renderPhoneBindCountryOptions(state.phoneBindSettings || {});
});

$('phoneBindSmsCountries').addEventListener('mousedown', (event) => {
  if (!(event.target instanceof HTMLOptionElement)) return;
  event.preventDefault();
  if (!(state.phoneBindCountrySelection instanceof Set)) state.phoneBindCountrySelection = new Set();
  const id = String(event.target.value);
  if (state.phoneBindCountrySelection.has(id)) state.phoneBindCountrySelection.delete(id);
  else state.phoneBindCountrySelection.add(id);
  state.phoneBindCountrySelectionDirty = true;
  state.phoneBindSettingsDraftDirty = true;
  event.target.selected = state.phoneBindCountrySelection.has(id);
  renderPhoneBindCountryOptions(state.phoneBindSettings || {});
});

$('savePhoneBindSettings').addEventListener('click', async () => {
  $('phoneBindSettingsFeedback').textContent = '正在保存接码配置…';
  try {
    const smsCountries = [...(state.phoneBindCountrySelection || [])];
    if (!smsCountries.length) throw new Error('至少选择一个接码国家');
    const body = {
      autoEnabled: hasCapability('phoneBind') && $('phoneBindAutoEnabled').checked,
      sub2BaseUrl: $('phoneBindSub2BaseUrl').value.trim(),
      smsCountries,
      smsPriceMin: Number($('phoneBindSmsPriceMin').value || 0),
      smsPriceMax: Number($('phoneBindSmsPriceMax').value || 0),
      smsTimeoutSeconds: Number($('phoneBindSmsTimeoutSeconds').value || 180),
      smsMaxAttempts: Number($('phoneBindSmsMaxAttempts').value || 12),
      smsPhoneRetryLimit: Number($('phoneBindSmsPhoneRetryLimit').value || 0),
      smsPreferGold: $('phoneBindSmsProviderRank').value === 'gold',
    };
    const apiKey = $('phoneBindSub2AdminApiKey').value.trim();
    if (apiKey) body.sub2AdminApiKey = apiKey;
    const smsApiKey = $('phoneBindSmsApiKey').value.trim();
    if (smsApiKey) body.smsApiKey = smsApiKey;
    state.phoneBindSettings = await api.put('/api/phone-bind/settings', body);
    state.phoneBindCountrySelection = new Set((state.phoneBindSettings.smsCountries || []).map(String));
    state.phoneBindCountrySelectionSource = [...state.phoneBindCountrySelection].join(',');
    state.phoneBindCountrySelectionDirty = false;
    state.phoneBindSettingsDraftDirty = false;
    $('phoneBindSub2AdminApiKey').value = '';
    $('phoneBindSmsApiKey').value = '';
    renderPhoneBindSettings();
    $('phoneBindSettingsFeedback').textContent = '接码配置已保存。';
  } catch (error) {
    $('phoneBindSettingsFeedback').textContent = `保存失败：${error.message}`;
  }
});

$('startRegistrationAutoStart')?.addEventListener('click', async () => {
  $('mailComSplitFeedback').textContent = '正在启动全局自动任务…';
  try {
    const result = await api.post('/api/registration/autostart/start', {});
    state.config.registration = state.config.registration || {};
    if (result.config) state.config.registration.autoStart = result.config;
    await refresh({ silent: true });
    setTab('mail');
    $('mailComSplitFeedback').textContent = '全局自动任务已启动，将按已保存配置和空闲并发槽持续读取可用邮箱。';
  } catch (error) {
    $('mailComSplitFeedback').textContent = `启动失败：${error.message}`;
  }
});

$('stopRegistrationAutoStart').addEventListener('click', async () => {
  $('mailComSplitFeedback').textContent = '正在停止全局自动任务…';
  try {
    const result = await api.post('/api/registration/autostart/stop', {});
    state.config.registration = state.config.registration || {};
    if (result.config) state.config.registration.autoStart = result.config;
    await refresh({ silent: true });
    $('mailComSplitFeedback').textContent = '全局自动任务已停止；不再读取 ready 邮箱，已排队和正在执行的任务继续完成。';
  } catch (error) {
    $('mailComSplitFeedback').textContent = `关闭失败：${error.message}`;
  }
});

$('importMailComMainAccounts').addEventListener('click', async () => {
  $('mailComSplitFeedback').textContent = '正在导入 mail.com 主邮箱…';
  try {
    const text = String(state.mailComDraft.mainImport || $('mailComMainImport').value || '');
    const result = await api.post('/api/mailbox/mail-com-split/accounts/import', { text });
    state.mailComDraft = { ...state.mailComDraft, mainImport: '' };
    $('mailComMainImport').value = '';
    await refresh({ silent: true });
    setTab('mail');
    $('mailComSplitFeedback').textContent = `已导入 ${result.imported?.length || 0} 个，更新 ${result.updated?.length || 0} 个，忽略 ${result.ignored || 0} 行。`;
  } catch (error) {
    $('mailComSplitFeedback').textContent = `导入失败：${error.message}`;
  }
});

$('fetchCfDomains').addEventListener('click', async () => {
  $('cfMailboxFeedback').textContent = '正在从 Worker 获取域名…';
  $('fetchCfDomains').disabled = true;
  try {
    const body = {
      baseUrl: $('cfBaseUrl').value,
    };
    const adminAuth = $('cfAdminAuth').value.trim();
    if (adminAuth) {
      body.adminAuth = adminAuth;
      body.customAuth = adminAuth;
    }
    const result = await api.post('/api/mailbox/cloudflare-temp-email/domains', body);
    state.cfDomainOptions = result.domains || [];
    state.cfRandomSubdomainOptions = Array.isArray(result.randomSubdomainDomains) ? result.randomSubdomainDomains : null;
    const currentConfig = state.cfMailbox || {};
    const current = normalizeDomain($('cfDomains').value || currentConfig.defaultDomain);
    const selected = state.cfDomainOptions.find((domain) => domain === current)
      || state.cfDomainOptions.find((domain) => current && domain.endsWith(`.${current}`))
      || state.cfDomainOptions[0]
      || current;
    state.cfMailbox = {
      ...currentConfig,
      baseUrl: $('cfBaseUrl').value.trim() || currentConfig.baseUrl || '',
      domains: selected ? [selected] : currentConfig.domains || [],
      defaultDomain: selected,
      randomSubdomain: Boolean(currentConfig.randomSubdomain),
    };
    state.cfMailboxDraftDirty = true;
    renderCloudflareMailboxConfig();
    $('cfMailboxFeedback').textContent = state.cfDomainOptions.length
      ? `已从 Worker 配置获取 ${state.cfDomainOptions.length} 个域名。`
      : `没有从最近 ${result.scanned || 0} 封邮件里发现域名。`;
  } catch (error) {
    $('cfMailboxFeedback').textContent = `获取域名失败：${error.message}`;
  } finally {
    $('fetchCfDomains').disabled = false;
  }
});

$('startCfGeneratedTask').addEventListener('click', startCloudflareGeneratedTask);
$('copySelectedIcAt')?.addEventListener('click', () => copySelectedAccessTokens('ic'));
$('copySelectedDomainAt')?.addEventListener('click', () => copySelectedAccessTokens('domain'));
$('copySelectedMailAt')?.addEventListener('click', () => copySelectedAccessTokens('mail_com'));

for (const card of document.querySelectorAll('[data-pool]')) {
  const category = card.dataset.pool;
  card.querySelector('.pool-select').addEventListener('change', (event) => {
    setSelectedProxyPool(category, event.target.value);
    renderProxyPools();
  });
  card.querySelector('.create-pool').addEventListener('click', async () => {
    const input = card.querySelector('.pool-name');
    const name = input.value.trim();
    if (!name) return;
    try {
      const pool = await api.post(`/api/proxy-pools/${category}`, { name });
      setSelectedProxyPool(category, pool.id);
      input.value = '';
      await refresh({ silent: true });
      setProxyFeedback(card, `已新建代理池：${name}`);
    } catch (error) {
      setProxyFeedback(card, `新建失败：${error.message}`);
    }
  });
  card.querySelector('.delete-pool').addEventListener('click', async () => {
    const poolId = proxyCardPoolId(card, category);
    if (!poolId) return;
    try {
      await api.delete(`/api/proxy-pools/${category}/${encodeURIComponent(poolId)}`);
      setSelectedProxyPool(category, DIRECT_PROXY_VALUE);
      await refresh({ silent: true });
      setProxyFeedback(card, '已删除代理池。');
    } catch (error) {
      setProxyFeedback(card, `删除失败：${error.message}`);
    }
  });
  card.querySelector('.import-proxies').addEventListener('click', async () => {
    const button = card.querySelector('.import-proxies');
    const textarea = card.querySelector('textarea');
    const text = textarea.value.trim();
    if (!text) {
      setProxyFeedback(card, '先粘贴代理，再导入。');
      return;
    }
    button.disabled = true;
    setProxyFeedback(card, '正在导入代理…');
    try {
      let poolId = proxyCardPoolId(card, category);
      if (!poolId) {
        const pool = await api.post(`/api/proxy-pools/${category}`, { name: '导入池' });
        poolId = pool.id;
        setSelectedProxyPool(category, poolId);
      }
      const result = await api.post(`/api/proxy-pools/${category}/${encodeURIComponent(poolId)}/proxies`, { proxies: text });
      if (result.imported > 0) textarea.value = '';
      await refresh({ silent: true });
      setProxyFeedback(card, result.imported > 0
        ? `已导入 ${result.imported} 条代理。`
        : '没有导入新代理：可能是格式不支持，或这些代理已经存在。');
    } catch (error) {
      setProxyFeedback(card, `导入失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  });
}

bootstrapInitialRender().catch((error) => {
  $('runtimeStatus').textContent = `加载失败：${error.message}`;
});

function noteUserInteraction(pauseMs) {
  state.userInteractionRevision += 1;
  suspendAutoRefresh(pauseMs);
}

document.addEventListener('pointerdown', () => noteUserInteraction(), true);
document.addEventListener('keydown', () => noteUserInteraction(), true);
document.addEventListener('input', () => noteUserInteraction(EDITING_REFRESH_PAUSE_MS), true);
document.addEventListener('focusin', () => noteUserInteraction(EDITING_REFRESH_PAUSE_MS), true);

checkFrontendVersion();
setInterval(() => autoRefresh().catch(() => {}), AUTO_REFRESH_INTERVAL_MS);
setInterval(() => checkFrontendVersion(), FRONTEND_VERSION_CHECK_MS);
