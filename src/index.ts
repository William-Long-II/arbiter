import { config } from './config.ts';
import { runMigrations, startEventListener } from './db.ts';
import {
  formatSetupBanner,
  loadAppSettings,
  setupNeeded,
} from './settings.ts';
import {
  formatSubscriptionPreflightError,
  preflightClaudeCli,
} from './review/runner.ts';
import { buildApp } from './web/server.tsx';
import { startWorker, stopWorker } from './worker.ts';
import { startPoller, stopPoller } from './github/poller.ts';
import { startRetention, stopRetention } from './retention.ts';

async function main(): Promise<void> {
  // Migrations and settings come first: the credential preflight below
  // needs the wizard-written token (app_settings) to judge fairly, so it
  // can no longer run DB-free at the very top.
  console.log('[boot] running migrations…');
  await runMigrations();
  await loadAppSettings();

  if (setupNeeded()) {
    // Fresh instance: no OAuth app to sign in with and (typically) no
    // Claude credentials yet. Skip the preflight — the wizard validates
    // the token live before saving — and boot into setup mode: the HTTP
    // server runs (everything redirects to /setup), the worker and poller
    // idle harmlessly with zero users.
    console.error(formatSetupBanner());
  } else if (config.claude.defaultMode === 'subscription') {
    // Fail fast on unreachable subscription credentials. Gated on the
    // default mode: per-scope api overrides are unaffected; a per-scope
    // subscription override while the default is api is the one edge this
    // doesn't pre-check (rare, and that review still fails loudly via
    // ReviewTimeoutError rather than hanging silently forever — the
    // watchdog already bounds it).
    console.log('[boot] preflighting subscription credentials (claude -p)…');
    const pre = await preflightClaudeCli();
    if (!pre.ok) {
      console.error(formatSubscriptionPreflightError(pre.detail));
      process.exit(1);
    }
    console.log('[boot] subscription credentials OK');
  }

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
