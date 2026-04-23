import { bootstrapFromYaml, isConfigured, loadConfigFromStore } from "./config.ts";
import { makeClient } from "./github/client.ts";
import { openStore } from "./state/db.ts";
import { runTick } from "./loop.ts";
import { log } from "./log.ts";
import { startWebServer } from "./web/server.ts";
import { createRuntime } from "./web/runtime.ts";
import { Breaker } from "./review/breaker.ts";

const DB_PATH = process.env.AUTO_REVIEWER_DB ?? "./data/state.sqlite";
const YAML_PATH = process.env.AUTO_REVIEWER_CONFIG ?? "./config.yaml";
const TOKEN = process.env.GITHUB_TOKEN;
const WEB_HOST = process.env.AUTO_REVIEWER_WEB_HOST ?? "127.0.0.1";
const WEB_PORT = Number(process.env.AUTO_REVIEWER_WEB_PORT ?? "8787");
const WEB_PASSWORD = process.env.AUTO_REVIEWER_PASSWORD ?? "";
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const OAUTH_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "";
const WEBHOOK_RETENTION_DAYS = Number(process.env.AUTO_REVIEWER_WEBHOOK_RETENTION_DAYS ?? "14");
const EVENT_RETENTION_DAYS = Number(process.env.AUTO_REVIEWER_EVENT_RETENTION_DAYS ?? "30");
const BREAKER_THRESHOLD = Number(process.env.AUTO_REVIEWER_BREAKER_THRESHOLD ?? "5");
const BREAKER_COOLDOWN_SECONDS = Number(process.env.AUTO_REVIEWER_BREAKER_COOLDOWN_SECONDS ?? "900");

if (!TOKEN) {
  log.error("startup.missing_token", { hint: "set GITHUB_TOKEN in the environment" });
  process.exit(1);
}

const store = openStore(DB_PATH);
{
  const counts = store.counts();
  const mb = (store.meta.sizeBytes / 1024).toFixed(1);
  log.info("storage.opened", {
    path: store.meta.path,
    freshlyCreated: store.meta.freshlyCreated,
    sizeKB: mb,
    ...counts,
  });
  store.recordEvent({
    level: store.meta.freshlyCreated ? "warn" : "info",
    kind: "storage.opened",
    message: store.meta.freshlyCreated
      ? `DB at ${store.meta.path} did NOT exist before boot — starting fresh. If you expected your previous setup to persist, check the ./data bind mount.`
      : `DB at ${store.meta.path} opened (${mb} KB). Reviews=${counts.reviews}, events=${counts.events}, orgs=${counts.orgs}, repos=${counts.repos}, skip_authors=${counts.skip_authors}.`,
    payload: { path: store.meta.path, freshlyCreated: store.meta.freshlyCreated, sizeBytes: store.meta.sizeBytes, ...counts },
  });
}

let bootstrapped = false;
try {
  bootstrapped = bootstrapFromYaml(store, YAML_PATH);
  if (bootstrapped) {
    log.info("startup.bootstrapped_from_yaml", { yaml: YAML_PATH });
    store.recordEvent({
      level: "info",
      kind: "startup.bootstrap",
      message: `Imported config from ${YAML_PATH} into the database. The YAML is no longer read after this; manage settings in the UI.`,
    });
  }
} catch (e) {
  log.warn("startup.bootstrap_failed", { error: (e as Error).message });
  store.recordEvent({
    level: "warn",
    kind: "startup.bootstrap",
    message: `Bootstrap from ${YAML_PATH} failed: ${(e as Error).message}`,
  });
}

const breaker = new Breaker({
  threshold: BREAKER_THRESHOLD,
  cooldownMs: BREAKER_COOLDOWN_SECONDS * 1_000,
  onTransition: ({ from, to, reason }) => {
    const level = to === "open" ? "warn" : "info";
    log[level](`breaker.${to}`, { from, reason });
    store.recordEvent({
      level,
      kind: `breaker.${to}`,
      message: `Claude circuit breaker: ${from} -> ${to}${reason ? " (" + reason + ")" : ""}`,
      payload: { from, to, reason },
    });
  },
});

const runtime = createRuntime({ bootstrappedFromYaml: bootstrapped, breaker });
const gh = makeClient(TOKEN);

const pruned = store.pruneEvents(EVENT_RETENTION_DAYS);
if (pruned > 0) {
  log.info("startup.events_pruned", { removed: pruned, retentionDays: EVENT_RETENTION_DAYS });
}
const prunedSessions = store.pruneExpiredSessions();
if (prunedSessions > 0) {
  log.info("startup.sessions_pruned", { removed: prunedSessions });
}
const prunedDeliveries = store.pruneWebhookDeliveries(WEBHOOK_RETENTION_DAYS);
if (prunedDeliveries > 0) {
  log.info("startup.webhook_deliveries_pruned", {
    removed: prunedDeliveries,
    retentionDays: WEBHOOK_RETENTION_DAYS,
  });
}

// OAuth client_id is persisted in the store (operator editable via Config UI),
// so we fetch it here instead of through an env var. The secret stays in env
// because it's, well, a secret — the DB snapshot concern.
const oauthClientId = store.getScalar("github.oauth_client_id") ?? "";

startWebServer({
  store,
  runtime,
  host: WEB_HOST,
  port: WEB_PORT,
  password: WEB_PASSWORD,
  webhookSecret: WEBHOOK_SECRET,
  oauthClientId,
  oauthClientSecret: OAUTH_CLIENT_SECRET,
});

if (!WEB_PASSWORD && WEB_HOST !== "127.0.0.1" && WEB_HOST !== "localhost") {
  log.warn("startup.insecure_bind", {
    host: WEB_HOST,
    hint: "bound to non-loopback without AUTO_REVIEWER_PASSWORD — anyone who can reach the port has full admin",
  });
  store.recordEvent({
    level: "warn",
    kind: "startup.insecure",
    message: `Listening on ${WEB_HOST} without a password. Set AUTO_REVIEWER_PASSWORD or bind to 127.0.0.1.`,
  });
}

log.info("startup.ok", { db: DB_PATH, web: `${WEB_HOST}:${WEB_PORT}` });
store.recordEvent({
  level: "info",
  kind: "startup.ok",
  message: `Started. UI at http://${WEB_HOST}:${WEB_PORT}`,
});

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    log.info("shutdown.signal", { signal: sig });
  });
}

while (!stopping) {
  const cfg = loadConfigFromStore(store);

  if (!isConfigured(cfg)) {
    log.info("tick.skipped", {
      reason: "not configured: set bot_username and at least one org or repo",
    });
    const waitMs = cfg.poll.interval_seconds * 1_000;
    runtime.nextTickAt = new Date(Date.now() + waitMs).toISOString();
    await sleepInterruptible(waitMs, () => stopping || runtime.wakeRequested);
    continue;
  }

  runtime.lastTickStart = new Date().toISOString();
  runtime.lastTickError = null;
  runtime.nextTickAt = null; // tick in progress
  // Consume the wake signal at tick start. If another webhook lands during
  // this tick, the flag will be re-set and the post-tick sleep sees it.
  runtime.wakeRequested = false;
  const started = Date.now();
  try {
    await runTick({ gh, cfg, store, progress: runtime, breaker });
  } catch (e) {
    const msg = (e as Error).message;
    runtime.lastTickError = msg;
    log.error("tick.failed", { error: msg });
    store.recordEvent({ level: "error", kind: "tick.failed", message: msg });
  }
  runtime.lastTickEnd = new Date().toISOString();
  const elapsedMs = Date.now() - started;
  const remainingMs = Math.max(0, cfg.poll.interval_seconds * 1_000 - elapsedMs);
  runtime.nextTickAt = new Date(Date.now() + remainingMs).toISOString();
  if (stopping) break;
  await sleepInterruptible(remainingMs, () => stopping || runtime.wakeRequested);
}

store.close();
log.info("shutdown.done");

function sleepInterruptible(ms: number, shouldStop: () => boolean): Promise<void> {
  const step = 250;
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (shouldStop() || Date.now() - start >= ms) return resolve();
      setTimeout(tick, step);
    };
    tick();
  });
}
