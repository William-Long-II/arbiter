import { config } from './config.ts';
import { runMigrations } from './db.ts';
import { buildApp } from './web/server.tsx';
import { startWorker, stopWorker } from './worker.ts';
import { startPoller, stopPoller } from './github/poller.ts';

async function main(): Promise<void> {
  console.log('[boot] running migrations…');
  await runMigrations();

  const app = buildApp();
  const server = Bun.serve({
    port: config.port,
    fetch: app.fetch,
  });
  console.log(`[boot] http listening on http://localhost:${server.port}`);

  startWorker();
  startPoller();

  const shutdown = (signal: string) => {
    console.log(`[boot] ${signal} received, shutting down`);
    stopWorker();
    stopPoller();
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
