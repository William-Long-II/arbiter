import { bootstrapFromYaml, isConfigured, loadConfigFromStore } from "./config.ts";
import { makeClient } from "./github/client.ts";
import { openStore } from "./state/db.ts";
import { runTick } from "./loop.ts";
import { log } from "./log.ts";
import { startWebServer } from "./web/server.ts";
import { createRuntime } from "./web/runtime.ts";

const DB_PATH = process.env.AUTO_REVIEWER_DB ?? "./data/state.sqlite";
const YAML_PATH = process.env.AUTO_REVIEWER_CONFIG ?? "./config.yaml";
const TOKEN = process.env.GITHUB_TOKEN;
const WEB_HOST = process.env.AUTO_REVIEWER_WEB_HOST ?? "127.0.0.1";
const WEB_PORT = Number(process.env.AUTO_REVIEWER_WEB_PORT ?? "8787");

if (!TOKEN) {
  log.error("startup.missing_token", { hint: "set GITHUB_TOKEN in the environment" });
  process.exit(1);
}

const store = openStore(DB_PATH);

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

const runtime = createRuntime(bootstrapped);
const gh = makeClient(TOKEN);

startWebServer({ store, runtime, host: WEB_HOST, port: WEB_PORT });

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
    await sleepInterruptible(cfg.poll.interval_seconds * 1_000, () => stopping);
    continue;
  }

  runtime.lastTickStart = new Date().toISOString();
  runtime.lastTickError = null;
  const started = Date.now();
  try {
    await runTick({ gh, cfg, store });
  } catch (e) {
    const msg = (e as Error).message;
    runtime.lastTickError = msg;
    log.error("tick.failed", { error: msg });
    store.recordEvent({ level: "error", kind: "tick.failed", message: msg });
  }
  runtime.lastTickEnd = new Date().toISOString();
  const elapsedMs = Date.now() - started;
  const remainingMs = Math.max(0, cfg.poll.interval_seconds * 1_000 - elapsedMs);
  if (stopping) break;
  await sleepInterruptible(remainingMs, () => stopping);
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
