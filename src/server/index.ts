import { createHmac, timingSafeEqual } from "node:crypto";
import { getAllowlist, loadAllowlist, loadConfig, reload } from "../config";
import { createOctokit, fetchAuthenticatedLogin } from "../github";
import { createAnthropic } from "../review";
import { runBootHealthCheck } from "../review/backends";
import { sweepDeadLetters, writeDeadLetter } from "./dead-letter";
import { replayRecentDeadLetters } from "./dead-letter-replay";
import { sweepAudit } from "../review/audit";
import { log } from "./logger";
import {
  buildMetricsHandler,
  incConfigReload,
  incRatelimitRejected,
  incWebhookReceived,
  incWebhookReplay,
  incWebhookSecretUsed,
  incWebhookUnknownEvent,
  observeShutdownDrain,
} from "./metrics";
import { getActiveCount, QueueFullError } from "./queue";
import {
  getQueueSnapshotIntervalSeconds,
  getQueueStateDir,
  restoreQueue,
  snapshotQueue,
} from "./queue-persistence";
import { rateLimiter } from "./rate-limit";
import { replayCache } from "./replay-cache";
import { createWebhooks, runPipeline } from "./webhooks";

/**
 * GitHub event names the bot actually handles.  Any other event arriving at
 * the webhook endpoint is rejected with 400 before signature verification
 * consumes CPU, so operators can see misconfigurations early.
 *
 * `ping` is sent by GitHub when a webhook is first created/updated and must
 * always be accepted.
 */
const KNOWN_EVENTS = new Set([
  "pull_request",
  "check_suite",
  "issue_comment",
  "pull_request_review_comment",
  "ping",
]);

const config = loadConfig();
// loadAllowlist seeds the mutable holder; getAllowlist() is used from here on.
loadAllowlist(config.reposPath);
const octokit = createOctokit(config.githubPat);
const anthropic = createAnthropic(config.anthropicApiKey);

// Boot-time health check for the claude-cli backend.  Exits with code 1 if
// LLM_BACKEND=claude-cli and the `claude` binary is absent or non-functional.
// No-op when LLM_BACKEND=api (the default).
await runBootHealthCheck();

const selfLogin =
  config.machineUserLogin ?? (await fetchAuthenticatedLogin(octokit));
log.info("machine user identity resolved", {
  login: selfLogin,
  source: config.machineUserLogin ? "env" : "github",
});

// Build one Webhooks instance per secret slot so we can dispatch via
// verifyAndReceive on whichever slot successfully pre-verified the request.
// Two instances are used rather than hand-rolling the dispatch path, keeping
// all event-handler wiring in createWebhooks unchanged.
const webhooksDeps = { getAllowlist, octokit, anthropic, selfLogin, jiraCreds: config.jira };
const webhooksPrimary = createWebhooks(config.githubWebhookSecret, webhooksDeps);
const webhooksSecondary = config.githubWebhookSecretSecondary
  ? createWebhooks(config.githubWebhookSecretSecondary, webhooksDeps)
  : null;

/**
 * Timing-safe HMAC-SHA256 comparison for a single secret.
 * Returns true when `signature` equals `sha256=<hmac(secret, payload)>`.
 * Using timingSafeEqual prevents timing-oracle attacks even if an attacker
 * can measure response latency precisely.
 */
function verifyHmac(payload: string, signature: string, secret: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    // Buffers were different lengths — definitely not equal.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Drain state — flipped to true on SIGTERM.
// While draining: /health and /ready return 503, /webhook returns 429.
// ---------------------------------------------------------------------------
let isDraining = false;

// ---------------------------------------------------------------------------
// Periodic queue snapshot (issue #92).
// Snaps every QUEUE_SNAPSHOT_INTERVAL_SECONDS; cleared on SIGTERM before drain.
// QUEUE_SNAPSHOT_INTERVAL_SECONDS=0 disables entirely.
// ---------------------------------------------------------------------------
let snapshotInterval: ReturnType<typeof setInterval> | null = null;

const SHUTDOWN_DRAIN_SECONDS = (() => {
  const raw = process.env["SHUTDOWN_DRAIN_SECONDS"];
  if (raw !== undefined) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 60;
})();

const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  routes: {
    "/health": (req) => {
      if (isDraining) return new Response("draining", { status: 503 });
      return new Response("ok");
    },
    "/ready": (req) => {
      if (isDraining) return new Response("draining", { status: 503 });
      return new Response("ok");
    },
    "/metrics": { GET: buildMetricsHandler() },
    "/webhook": {
      POST: (req) => handleWebhook(req, webhooksPrimary, webhooksSecondary),
    },
  },
  fetch() {
    return new Response("not found", { status: 404 });
  },
  error(err) {
    log.error("server error", { error: err.message });
    return new Response("internal error", { status: 500 });
  },
});

log.info("server started", {
  hostname: server.hostname,
  port: server.port,
  allowlistedRepos: Object.keys(getAllowlist().all()).length,
  jiraConfigured: Boolean(config.jira),
  webhookSecondarySecret: Boolean(config.githubWebhookSecretSecondary),
});

// ---------------------------------------------------------------------------
// SIGHUP — hot-reload repos.yaml without a restart.
// On parse/IO error the old snapshot is preserved; we never swap to a broken one.
// Note: SIGHUP is not available on Windows; Bun silently ignores the handler there.
// ---------------------------------------------------------------------------
process.on("SIGHUP", () => {
  const result = reload();
  if (result.ok) {
    incConfigReload("success");
    log.info("config reloaded", { evt: "config.reload", ok: true, repos_count: result.count });
  } else {
    incConfigReload("failure");
    log.error("config reload failed", { evt: "config.reload", ok: false, error: result.error });
  }
});

// ---------------------------------------------------------------------------
// SIGTERM — graceful shutdown.
//
// 1. Set isDraining so reverse proxies stop sending traffic.
// 2. Poll activeCount() every 250ms until it reaches 0 or timeout.
// 3. Observe the drain histogram, stop the HTTP server, exit.
//
// WHY only SIGTERM: SIGINT is kept as fast-kill for local dev ergonomics.
// process.exit(0) after server.stop() intentionally skips any Bun runtime
// finalizers — that is acceptable here because all reviews are either
// complete or we have already waited as long as SHUTDOWN_DRAIN_SECONDS allows.
// ---------------------------------------------------------------------------
process.on("SIGTERM", () => {
  isDraining = true;
  log.info("graceful shutdown started", { evt: "shutdown.draining" });

  // Stop periodic snapshots — we are about to take a final snapshot below.
  if (snapshotInterval !== null) {
    clearInterval(snapshotInterval);
    snapshotInterval = null;
  }

  // Snapshot pending (not yet started) tasks BEFORE accepting new connections
  // stop.  Tasks that are currently executing will finish during the drain;
  // they are not in the pending map so they are not double-counted.
  snapshotQueue().catch(() => {
    // snapshotQueue never throws, but belt-and-suspenders.
  });

  const drainStart = Date.now();
  const maxWaitMs = SHUTDOWN_DRAIN_SECONDS * 1_000;
  const pollIntervalMs = 250;

  const poll = setInterval(() => {
    const active = getActiveCount();
    const elapsedMs = Date.now() - drainStart;

    if (active === 0 || elapsedMs >= maxWaitMs) {
      clearInterval(poll);

      const waitedSeconds = elapsedMs / 1_000;
      const timedOut = active > 0;

      log.info("graceful shutdown complete", {
        evt: "shutdown.drained",
        waited_seconds: waitedSeconds,
        timed_out: timedOut,
      });

      observeShutdownDrain(waitedSeconds);

      // server.stop() may throw on Bun if already stopped; swallow and exit.
      try {
        server.stop();
      } catch (_err) {
        // Ignore — we are exiting regardless.
      }
      process.exit(0);
    }
  }, pollIntervalMs);
});

// Prune old dead-letter dirs at startup (non-fatal).
sweepDeadLetters().catch((err: unknown) => {
  log.error("dead letter sweep failed at startup", {
    error: err instanceof Error ? err.message : String(err),
  });
});

// Auto-replay recent dead letters after sweep (fire-and-forget; never blocks boot).
// WHY after sweep: sweep removes whole date-dirs older than retention; replay only
// touches recent files — running after sweep avoids reading dirs that are about
// to be deleted anyway.
if (config.deadLetterAutoReplay === "enabled") {
  const replayDir = process.env.DEAD_LETTER_DIR ?? "var/dead-letter";
  // Use a bypass secret so we can re-sign without needing the original webhook
  // secret available at replay time (same pattern as the manual script).
  const REPLAY_BYPASS_SECRET = "__auto_replay_bypass__";
  replayRecentDeadLetters({
    dir: replayDir,
    maxAgeMinutes: config.deadLetterReplayMaxAgeMinutes,
    maxCount: config.deadLetterReplayMaxCount,
    webhooks: createWebhooks(REPLAY_BYPASS_SECRET, webhooksDeps),
    replaySecret: REPLAY_BYPASS_SECRET,
  }).catch((err: unknown) => {
    log.error("dead letter auto-replay failed at startup", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// Prune old audit dirs at startup (non-fatal).
sweepAudit().catch((err: unknown) => {
  log.error("audit sweep failed at startup", {
    error: err instanceof Error ? err.message : String(err),
  });
});

// Restore in-flight tasks that were snapshotted before the last shutdown.
// Fire-and-forget; never blocks boot.
restoreQueue(
  getQueueStateDir(),
  { octokit, anthropic, selfLogin, jiraCreds: config.jira },
  runPipeline,
).catch((err: unknown) => {
  log.error("queue restore failed at startup", {
    error: err instanceof Error ? err.message : String(err),
  });
});

// Periodic snapshot — runs every QUEUE_SNAPSHOT_INTERVAL_SECONDS so a crash
// between SIGTERM snapshots loses at most one interval worth of tasks.
// QUEUE_SNAPSHOT_INTERVAL_SECONDS=0 disables entirely.
const snapshotIntervalSeconds = getQueueSnapshotIntervalSeconds();
if (snapshotIntervalSeconds > 0) {
  snapshotInterval = setInterval(() => {
    snapshotQueue().catch(() => {
      // snapshotQueue never throws, belt-and-suspenders.
    });
  }, snapshotIntervalSeconds * 1_000);
  // Prevent the interval from keeping the process alive during normal exit.
  if (snapshotInterval.unref) {
    snapshotInterval.unref();
  }
}

export async function handleWebhook(
  req: Request,
  webhooksPrimary: ReturnType<typeof createWebhooks>,
  webhooksSecondary: ReturnType<typeof createWebhooks> | null = null,
): Promise<Response> {
  // Refuse new work while draining.
  if (isDraining) {
    return new Response("shutting down", { status: 429 });
  }

  // ---------------------------------------------------------------------------
  // Rate limit check — BEFORE signature verification.
  // WHY before signature: HMAC is O(payload size); a cheap hash-map lookup
  // should gate expensive crypto work. Callers without a valid installation
  // header share the "(no-installation)" bucket — see note in rate-limit.ts.
  //
  // Key: prefer the explicit installation-target-id header; fall back to the
  // literal constant so requests lacking it don't escape rate limiting entirely.
  // The fallback key acts as a "noisy neighbour" bucket — see honest concerns
  // in the PR self-review.
  // ---------------------------------------------------------------------------
  const installation =
    req.headers.get("x-github-hook-installation-target-id") ?? "(no-installation)";

  const rl = rateLimiter.check(installation);
  if (!rl.allowed) {
    log.warn("webhook rate limited", {
      evt: "webhook.ratelimited",
      installation,
      retry_after_seconds: rl.retryAfterSeconds,
    });
    incRatelimitRejected(installation);
    return new Response("rate limit exceeded", {
      status: 429,
      headers: { "Retry-After": String(rl.retryAfterSeconds) },
    });
  }

  const id = req.headers.get("x-github-delivery");
  const name = req.headers.get("x-github-event");
  const signature = req.headers.get("x-hub-signature-256");

  if (!id || !name || !signature) {
    log.warn("webhook missing required headers", {
      hasId: Boolean(id),
      hasName: Boolean(name),
      hasSignature: Boolean(signature),
    });
    return new Response("missing required headers", { status: 400 });
  }

  // Reject unknown events before doing any signature work so misconfigurations
  // are visible early and don't burn CPU on crypto verification.
  if (!KNOWN_EVENTS.has(name)) {
    log.warn("webhook rejected: unknown event", {
      evt: "webhook.unknown_event",
      event: name,
      delivery_id: id,
    });
    incWebhookUnknownEvent(name);
    return new Response("unknown event", { status: 400 });
  }

  const payload = await req.text();
  incWebhookReceived(name);

  // Pre-verify the signature independently before touching the replay cache.
  // WHY hand-rolled HMAC instead of webhooks.verify(): we need to try two
  // secrets and pick the matching Webhooks instance for dispatch.
  // timingSafeEqual is used to prevent timing-oracle attacks.
  //
  // Ordering:
  //   1. Try primary (the common, post-rotation steady state).
  //   2. If primary fails and secondary is configured, try secondary.
  //   3. Return 401 only when both fail.
  //
  // Inserting into the replay cache AFTER verify but BEFORE dispatch means a
  // concurrent duplicate delivery is still rejected even during slow handlers.
  let matchedWebhooks: ReturnType<typeof createWebhooks>;
  let secretSlot: "primary" | "secondary";

  if (verifyHmac(payload, signature, config.githubWebhookSecret)) {
    matchedWebhooks = webhooksPrimary;
    secretSlot = "primary";
  } else if (
    webhooksSecondary !== null &&
    config.githubWebhookSecretSecondary !== undefined &&
    verifyHmac(payload, signature, config.githubWebhookSecretSecondary)
  ) {
    matchedWebhooks = webhooksSecondary;
    secretSlot = "secondary";
    // Signal operators that rotation is in progress and the secondary secret
    // is actively being used; they can grep for this event to confirm GitHub
    // has been updated to the new secret.
    log.info("webhook verified with secondary secret", {
      evt: "webhook.secret_secondary_used",
      delivery_id: id,
    });
  } else {
    log.warn("webhook signature rejected", { deliveryId: id });
    return new Response("invalid signature", { status: 401 });
  }

  incWebhookSecretUsed(secretSlot);

  // Replay check: insert delivery ID into the nonce cache.  If the ID is
  // already present and unexpired, the request is a replay.
  const { fresh } = replayCache.tryInsert(id);
  if (!fresh) {
    log.warn("webhook replay detected", {
      evt: "webhook.replay",
      delivery_id: id,
      event: name,
    });
    incWebhookReplay();
    return new Response("duplicate delivery", { status: 409 });
  }

  try {
    await matchedWebhooks.verifyAndReceive({
      id,
      name: name as Parameters<typeof matchedWebhooks.verifyAndReceive>[0]["name"],
      signature,
      payload,
    });
  } catch (err) {
    if (err instanceof QueueFullError) {
      log.warn("webhook rejected: review queue full", { deliveryId: id });
      return new Response("review queue full", { status: 503 });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("signature does not match")) {
      // This path is effectively unreachable now that we pre-verify above, but
      // we keep it as a defensive fallback in case the library's internal
      // verification disagrees with the standalone verify() call.
      log.warn("webhook signature rejected (double-check)", { deliveryId: id });
      return new Response("invalid signature", { status: 401 });
    }
    log.error("webhook processing error", { deliveryId: id, error: message });

    // Collect all request headers into a plain object for the dead-letter record.
    const headersMap: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headersMap[key] = value;
    });

    await writeDeadLetter({
      delivery_id: id,
      event: name,
      headers: headersMap,
      payload,
      error: err,
      attempts: 1,
    });

    return new Response("processing error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
}
