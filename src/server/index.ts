import { getAllowlist, loadAllowlist, loadConfig, reload } from "../config";
import { createOctokit, fetchAuthenticatedLogin } from "../github";
import { createAnthropic } from "../review";
import { sweepDeadLetters, writeDeadLetter } from "./dead-letter";
import { log } from "./logger";
import {
  buildMetricsHandler,
  incConfigReload,
  incRatelimitRejected,
  incWebhookReceived,
  incWebhookReplay,
  incWebhookUnknownEvent,
  observeShutdownDrain,
} from "./metrics";
import { getActiveCount, QueueFullError } from "./queue";
import { rateLimiter } from "./rate-limit";
import { replayCache } from "./replay-cache";
import { createWebhooks } from "./webhooks";

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

const selfLogin =
  config.machineUserLogin ?? (await fetchAuthenticatedLogin(octokit));
log.info("machine user identity resolved", {
  login: selfLogin,
  source: config.machineUserLogin ? "env" : "github",
});

const webhooks = createWebhooks(config.githubWebhookSecret, {
  getAllowlist,
  octokit,
  anthropic,
  selfLogin,
  jiraCreds: config.jira,
});

// ---------------------------------------------------------------------------
// Drain state — flipped to true on SIGTERM.
// While draining: /health and /ready return 503, /webhook returns 429.
// ---------------------------------------------------------------------------
let isDraining = false;

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
      POST: (req) => handleWebhook(req, webhooks),
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

export async function handleWebhook(
  req: Request,
  webhooks: ReturnType<typeof createWebhooks>,
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
  // We use webhooks.verify() (standalone, synchronous-equivalent) so that:
  //   1. Signature errors return 401 cleanly without inserting into the cache.
  //   2. We can insert into the cache BEFORE dispatching the event, so that
  //      a second concurrent request with the same ID arriving during a slow
  //      handler is still rejected.
  // This is why we split verify + dispatch instead of calling verifyAndReceive
  // alone — verifyAndReceive runs handlers inline, making it impossible to
  // intercept between verification and dispatch.
  const signatureValid = await webhooks.verify(payload, signature);
  if (!signatureValid) {
    log.warn("webhook signature rejected", { deliveryId: id });
    return new Response("invalid signature", { status: 401 });
  }

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
    await webhooks.verifyAndReceive({
      id,
      name: name as Parameters<typeof webhooks.verifyAndReceive>[0]["name"],
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
