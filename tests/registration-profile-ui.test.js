'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const capabilities = {
  registration: true, mailbox: true, proxies: true, credentials: true,
  payment: false, paymentMethodProbe: false, refining: false,
  phoneBind: false, browserRegistration: false,
};

function loadFunctions(context, names) {
  for (const name of names) {
    const match = new RegExp(String.raw`(?:async )?function ${name}\(`).exec(source);
    assert.ok(match, name);
    const end = source.indexOf('\n}', match.index) + 2;
    vm.runInContext(source.slice(match.index, end), context);
  }
}

function fixture(config = { capabilities }) {
  const calls = [];
  const nodes = [];
  const context = vm.createContext({
    state: { config, activeTab: 'payment', activeMailWorkflowStage: 'refining', emails: [], tasks: [], selectedEmailIds: new Set(), expandedTaskIds: new Set() },
    api: { get: async (url) => { calls.push(url); return url.includes('registration-view') ? { byEmail: {}, summary: {} } : []; } },
    localStorage: { setItem() {} },
    document: {
      querySelectorAll: (selector) => nodes.filter((node) => selector.includes(`[${node.attribute}]`)),
      querySelector: () => null,
    },
    renderVisibleTab() {},
    isImportedTask: () => false,
  });
  loadFunctions(context, ['hasCapability', 'viewEnabled', 'workflowStageEnabled', 'visibleWorkflowStage', 'assertApiCapability', 'applyCapabilities', 'setTab']);
  return { context, calls, nodes };
}

test('missing capabilities preserves legacy navigation and API access', () => {
  const { context } = fixture({});
  for (const tab of ['run', 'mail', 'proxies', 'refining', 'payment', 'phone-bind']) assert.equal(context.viewEnabled(tab), true);
  assert.equal(context.visibleWorkflowStage('payment_method'), 'payment_method');
  assert.doesNotThrow(() => context.assertApiCapability('/api/accounts/a/phone-bind'));
});

test('registration profile blocks unrelated requests but keeps post-registration APIs', () => {
  const { context } = fixture();
  for (const url of ['/api/refining', '/api/refining/service/check', '/api/payment/settings', '/api/payment-method-probe/settings', '/api/accounts/a/payment/start', '/api/accounts/a/payment-methods/probe', '/api/accounts/a/phone-bind', '/api/accounts/a/phone-bind/code', '/api/accounts/a/gcash/status']) {
    assert.throws(() => context.assertApiCapability(url), /未启用/);
  }
  for (const url of ['/api/accounts/a/eligibility', '/api/accounts/a/credential-repair', '/api/accounts/a/credential-export', '/api/accounts/a/access-token', '/api/phone-bind/settings', '/api/registration/change-email/settings', '/api/tasks']) {
    assert.doesNotThrow(() => context.assertApiCapability(url));
  }
  for (const method of ['get', 'post', 'put', 'delete']) assert.match(source, new RegExp(String.raw`async ${method}\(path[^)]*\) \{\s*assertApiCapability\(path\)`));
});

test('full refresh resolves config before parallel reads and skips disabled endpoints', async () => {
  const { context, calls } = fixture(null);
  context.fetchConfigState = async () => {
    calls.push('/api/config');
    await Promise.resolve();
    context.state.config = { capabilities };
  };
  loadFunctions(context, ['fetchProxyState', 'fetchPaymentState', 'fetchPhoneBindState', 'fetchMailComState', 'fetchBaseRuntimeState', 'fetchTaskState', 'reconcileLiveSelections', 'refreshAllData']);
  await context.refreshAllData();
  assert.equal(calls[0], '/api/config');
  assert.ok(calls.includes('/api/phone-bind/settings'));
  assert.ok(calls.includes('/api/emails'));
  assert.ok(calls.includes('/api/proxy-pools'));
  assert.ok(calls.includes('/api/mailbox/mail-com-split/accounts'));
  assert.ok(calls.some((url) => url.startsWith('/api/tasks')));
  assert.ok(!calls.some((url) => /^\/api\/(refining|payment)/.test(url)));
});

test('legacy refresh still reads payment and refining', async () => {
  const { context, calls } = fixture({});
  loadFunctions(context, ['fetchPaymentState', 'fetchBaseRuntimeState']);
  await context.fetchPaymentState();
  await context.fetchBaseRuntimeState();
  for (const url of ['/api/refining', '/api/payment/settings', '/api/payment-method-probe/settings']) assert.ok(calls.includes(url));
});

test('capability navigation hides panels without removing DOM and recovers stale views', () => {
  const { context, nodes } = fixture();
  function node(attribute, key, value) {
    const result = { attribute, dataset: { [key]: value }, classList: { toggle(name, active) { result.active = active; } } };
    nodes.push(result);
    return result;
  }
  const run = node('data-view', 'view', 'run');
  const payment = node('data-view', 'view', 'payment');
  const phone = node('data-tab', 'tab', 'phone-bind');
  const main = node('data-pool', 'pool', 'main');
  const eligibilityPool = node('data-pool', 'pool', 'eligibility');
  const checkout = node('data-pool', 'pool', 'checkout');
  const eligibility = node('data-mail-workflow-stage', 'mailWorkflowStage', 'eligibility');
  const finalPayment = node('data-pipeline-stage', 'pipelineStage', 'finalPayment');
  context.applyCapabilities();
  assert.equal(context.state.activeTab, 'run');
  assert.equal(context.state.activeMailWorkflowStage, 'preparing');
  assert.equal(run.active, true);
  for (const entry of [payment, phone, checkout, finalPayment]) assert.equal(entry.hidden, true);
  for (const entry of [run, main, eligibilityPool, eligibility]) assert.equal(entry.hidden, false);
  context.setTab('payment');
  assert.equal(context.state.activeTab, 'run');
  assert.equal(context.visibleWorkflowStage('refining'), 'completed');
  assert.equal(context.visibleWorkflowStage('eligibility'), 'eligibility');
});

test('lightweight navigation normalizes disabled views after loading config', async () => {
  const { context, calls } = fixture(null);
  context.fetchConfigState = async () => { context.state.config = { capabilities }; };
  context.VIEW_REFRESHERS = { run: async () => calls.push('run'), payment: async () => calls.push('payment') };
  context.reconcileLiveSelections = () => {};
  loadFunctions(context, ['ensureConfigState', 'refreshViewData']);
  await context.refreshViewData('payment');
  assert.deepEqual(calls, ['run']);
});

test('complete registration controls and unrelated binding targets remain in DOM', () => {
  for (const id of ['registrationSetupPassword', 'registrationSetupTotp2fa', 'registrationValidateOauthSession', 'registrationAutoCheckEligibility', 'registrationPhoneBindProbeEnabled', 'registrationChangeEmailEnabled', 'saveRegistrationChangeEmailSettings', 'savePhoneBindSettings', 'phoneBindSmsCountries', 'paymentEnabled', 'refiningEnabled', 'startCfGeneratedTask', 'mainProxyPoolSelect']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  assert.match(source, /autoCheckEligibility: Boolean\(\$\('registrationAutoCheckEligibility'\)/);
  assert.match(source, /if \(!hasCapability\('refining'\)\) \{ cleanup\(\); return; \}/);
  assert.match(source, /hasCapability\('phoneBind'\) \? miniAction/);
  const startup = source.slice(source.lastIndexOf('bootstrapInitialRender().catch'));
  assert.doesNotMatch(startup, /setTab\('payment'\)/);
});

test('completed registration keeps credentials and eligibility without standalone phone or sales actions', () => {
  const { context } = fixture();
  Object.assign(context, {
    normalizeEmailKey: (value) => value,
    registrationSourceKind: () => 'ic',
    credentialExportUnavailableReason: () => '',
    protocolEligibilityReady: () => true,
    miniAction: (label) => ({ label, addEventListener() {} }),
  });
  loadFunctions(context, ['workflowActionButtons']);
  const buttons = context.workflowActionButtons({ email: 'fixture@example.test' }, { accessTokenAvailable: true }, 'paid', {});
  const labels = Array.from(buttons, (button) => button.label);
  assert.ok(labels.includes('复制账号'));
  assert.ok(labels.includes('复制 AT'));
  assert.ok(labels.includes('复核资格'));
  assert.ok(!labels.includes('接码'));
  assert.ok(!labels.includes('标记已售'));
});

test('single FreePP selector stays hidden with its DOM and event binding intact', () => {
  const select = { replaceChildren(...options) { this.options = options; } };
  const field = {};
  const context = vm.createContext({
    $: (id) => id === 'entryBranchSelect' ? select : field,
    selectedExecutionType: () => 'protocol',
    selectedEntryBranch: () => 'freepp',
    implementationsForType: () => [{ id: 301, key: 'freepp', label: 'FreePP' }],
    document: { createElement: () => ({ dataset: {} }) },
    renderBrowserEngineSelect() {},
  });
  loadFunctions(context, ['renderEntryBranchSelect']);
  context.renderEntryBranchSelect();
  assert.equal(field.hidden, true);
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].dataset.key, 'freepp');
  assert.equal(select.options[0].selected, true);
  assert.match(html, /id="entryBranchSelect"/);
  assert.ok(source.includes("$('entryBranchSelect').addEventListener('change'"));
});

test('proxy panels follow the server category list and proxy capability', () => {
  const { context, nodes } = fixture({ capabilities, proxyPools: ['main', 'eligibility'] });
  for (const pool of ['main', 'eligibility', 'checkout', 'payment']) nodes.push({ attribute: 'data-pool', dataset: { pool } });
  context.applyCapabilities();
  assert.deepEqual(nodes.map(node => node.hidden), [false, false, true, true]);
  context.state.config.proxyPools = ['main'];
  context.applyCapabilities();
  assert.equal(nodes[1].hidden, true);
  context.state.config.capabilities = { ...capabilities, proxies: false };
  context.applyCapabilities();
  assert.ok(nodes.every(node => node.hidden));
});
