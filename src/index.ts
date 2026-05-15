import { config } from './config.ts';
import { runMigrations, startEventListener } from './db.ts';
import {
  formatSubscriptionPreflightError,
  preflightClaudeCli,
} from './review/runner.ts';
import { buildApp } from './web/server.tsx';
import { startWorker, stopWorker } from './worker.ts';
import { startPoller, stopPoller } from './github/poller.ts';
import { startRetention, stopRetention } from './retention.ts';

async function main(): Promise<void> {
  // Fail fast on unreachable subscription credentials. Done before any
  // other boot work (no DB dependency) so the error is the first thing
  // in the logs. Gated on the default mode: per-scope api overrides are
  // unaffected; a per-scope subscription override while the default is
  // api is the one edge this doesn't pre-check (rare, and that review
  // still fails loudly via ReviewTimeoutError rather than hanging silently
  // forever — the watchdog already bounds it).
  if (config.claude.defaultMode === 'subscription') {
    console.log('[boot] preflighting subscription credentials (claude -p)…');
    const pre = await preflightClaudeCli();
    if (!pre.ok) {
      console.error(formatSubscriptionPreflightError(pre.detail));
      process.exit(1);
    }
    console.log('[boot] subscription credentials OK');
  }

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
    // Bun's default idleTimeout is 10s. The SSE stream at /api/events/queue
    // legitimately stays idle between worker state changes, so the default
    // closes long-lived connections every 10s — which surfaces in the
    // browser console as ERR_INCOMPLETE_CHUNKED_ENCODING and triggers an
    // EventSource reconnect storm. Disable the per-connection timeout
    // entirely; SSE handlers manage their own lifecycle via stream.onAbort.
    idleTimeout: 0,
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
