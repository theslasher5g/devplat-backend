import { config } from './config.js';
import { migrate } from './migrate.js';
import { buildServer } from './server.js';

/**
 * How long to let in-flight work finish after SIGTERM before giving up.
 *
 * Docker sends SIGTERM on `docker compose up -d --build api` and SIGKILLs
 * whatever is left after its stop grace period, so this has to stay under the
 * `stop_grace_period` in deploy/docker-compose.api.yml (30s) or the kill
 * arrives first and the drain was pointless.
 */
const SHUTDOWN_GRACE_MS = 20_000;

async function main(): Promise<void> {
  await migrate();
  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });

  /*
   * Graceful shutdown.
   *
   * Node's default action for SIGTERM is to terminate immediately, so without
   * this every deploy severed whatever was in flight — including the WebSocket
   * tunnels carrying customers' running test suites. A test that had been
   * going for four minutes died because we shipped a copy edit.
   *
   * `app.close()` stops accepting new connections, runs the onClose hooks
   * (which stop the scheduler loops), and waits for in-flight requests. The
   * deadline is a backstop: a wedged handler must not keep the old container
   * alive until Docker kills it, because the new one is already taking
   * traffic.
   */
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    // A second Ctrl-C means "I meant it" — exit now rather than restarting the
    // wait. Also guards against SIGTERM arriving twice during a deploy.
    if (shuttingDown) {
      app.log.warn(`${signal} received again — exiting immediately`);
      process.exit(1);
    }
    shuttingDown = true;
    app.log.info(`${signal} received — draining, up to ${SHUTDOWN_GRACE_MS / 1000}s`);

    const deadline = setTimeout(() => {
      app.log.error('drain did not finish in time — forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    // Don't let the timer itself hold the event loop open once we're done.
    deadline.unref();

    try {
      await app.close();
      app.log.info('drained cleanly');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error while draining');
      process.exit(1);
    }
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
