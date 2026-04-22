import { loadConfig } from "./config.ts";
import { makeClient } from "./github/client.ts";
import { openStore } from "./state/db.ts";
import { runTick } from "./loop.ts";
import { log } from "./log.ts";

const CONFIG_PATH = process.env.AUTO_REVIEWER_CONFIG ?? "./config.yaml";
const DB_PATH = process.env.AUTO_REVIEWER_DB ?? "./data/state.sqlite";
const TOKEN = process.env.GITHUB_TOKEN;

if (!TOKEN) {
  log.error("startup.missing_token", { hint: "set GITHUB_TOKEN in the environment" });
  process.exit(1);
}

const cfg = loadConfig(CONFIG_PATH);
const gh = makeClient(TOKEN);
const store = openStore(DB_PATH);

log.info("startup.ok", {
  config: CONFIG_PATH,
  db: DB_PATH,
  dryRun: cfg.review.dry_run,
  intervalSeconds: cfg.poll.interval_seconds,
  orgs: cfg.watch.orgs.length,
  repos: cfg.watch.repos.length,
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
  const started = Date.now();
  try {
    await runTick({ gh, cfg, store });
  } catch (e) {
    log.error("tick.failed", { error: (e as Error).message });
  }
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
