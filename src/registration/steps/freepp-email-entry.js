'use strict';

const { openAuthEmailEntry } = require('./auth-email-entry');

async function openFreeppEmailEntry({ page, email, timeoutMs, onEvent }) {
  const emit = (event) => {
    try {
      if (typeof onEvent === 'function') onEvent(event);
    } catch {}
  };
  emit({ step: 'freepp_entry_started' });
  const result = await openAuthEmailEntry({
    page,
    email,
    timeoutMs,
    onEvent: (event) => emit({
      ...(event || {}),
      step: event?.step ? `freepp_${event.step}` : 'freepp_auth_event',
    }),
  });
  emit({
    step: 'freepp_entry_ready',
    result: {
      branch: result?.branch || null,
      nextStepKind: result?.emailSubmit?.nextStepKind || null,
      mode: result?.mode || null,
    },
  });
  return {
    ...result,
    mode: 'freepp_nextauth_authorize',
    sourceBranch: 'freepp',
  };
}

module.exports = {
  openFreeppEmailEntry,
};
