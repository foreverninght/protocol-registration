'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStopHandler } = require('../src/app/main');

test('shutdown is idempotent and closes lingering HTTP connections after the grace period', () => {
  const calls = [];
  const timers = [];
  let closeCallback = null;
  const server = {
    close(callback) {
      calls.push('close');
      closeCallback = callback;
    },
    closeIdleConnections() {
      calls.push('idle');
    },
    closeAllConnections() {
      calls.push('all');
      closeCallback?.();
    },
  };
  const stop = createStopHandler(server, {
    exit: (code) => calls.push(`exit:${code}`),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });

  stop();
  stop();
  assert.deepEqual(calls, ['idle', 'close']);
  assert.deepEqual(timers.map((timer) => timer.delay), [20000, 5000]);
  timers.find((timer) => timer.delay === 5000).callback();
  assert.deepEqual(calls, ['idle', 'close', 'all', 'exit:0']);
  assert.ok(timers.every((timer) => timer.cleared));
});

test('shutdown exits with failure when graceful cleanup exceeds its hard deadline', () => {
  const exits = [];
  const timers = [];
  const stop = createStopHandler({
    close() {},
    closeIdleConnections() {},
    closeAllConnections() {},
  }, {
    exit: (code) => exits.push(code),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
  });

  stop();
  timers.find((timer) => timer.delay === 20000).callback();
  assert.deepEqual(exits, [1]);
});
