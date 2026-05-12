import { config } from './config.ts';
import { runMigrations, startEventListener } from './db.ts';
import { buildApp } from './web/server.tsx';
import { startWorker, stopWorker } from './worker.ts';
import { startPoller, stopPoller } from './github/poller.ts';
import { startRetention, stopRetention } from './retention.ts';

async function main(): Promise<void> {
  console.log('[boot] running migrations…');
  await runMigrations();

  // Start the Postgres LISTEN for review state changes BEFORE accepting
  // HTTP requests, so the SSE route can subscribe to a live bus from
  // the first request.
  await startEventListener();

  const app = buildApp();
  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });
  console.log(`[boot] http listening on http://localhost:${server.port}`);

  startWorker();
  startPoller();
  startRetention();

  const shutdown = (signal: string) => {
    console.log(`[boot] ${signal} received, shutting down`);
    stopWorker();
    stopPoller();
    stopRetention();
    server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[boot] fatal:', err);
  process.exit(1);
});
