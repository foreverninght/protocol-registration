'use strict';

const { loadConfig } = require('./config');
const { createServerApp } = require('./server');

function createStopHandler(server, {
  exit = (code) => process.exit(code),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  connectionGraceMs = 5000,
  forceExitMs = 20000,
} = {}) {
  let stopping = false;
  return () => {
    if (stopping) return;
    stopping = true;
    const forceExitTimer = setTimer(() => exit(1), forceExitMs);
    forceExitTimer.unref?.();
    const connectionTimer = setTimer(() => server.closeAllConnections?.(), connectionGraceMs);
    connectionTimer.unref?.();
    server.closeIdleConnections?.();
    server.close((error) => {
      clearTimer(connectionTimer);
      clearTimer(forceExitTimer);
      exit(error ? 1 : 0);
    });
  };
}

async function main() {
  const config = loadConfig();
  const app = await createServerApp({ config });
  const server = app.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(`signlist-clean listening on http://${config.host}:${config.port}`);
  });
  const stop = createStopHandler(server);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}

module.exports = { createStopHandler, main };
