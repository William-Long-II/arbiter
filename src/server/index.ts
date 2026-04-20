import { getAllowlist, loadAllowlist, loadConfig, reload } from "../config";
import { createOctokit, fetchAuthenticatedLogin } from "../github";
import { createAnthropic } from "../review";
import { sweepDeadLetters, writeDeadLetter } from "./dead-letter";
import { log } from "./logger";
import {
  buildMetricsHandler,
  incConfigReload,
  incWebhookReceived,
  incWebhookReplay,
  incWebhookUnknownEvent,
} from "./metrics";
import { QueueFullError } from "./queue";
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

const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  routes: {
    "/health": new Response("ok"),
    "/ready": new Response("ok"),
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

// Prune old dead-letter dirs at startup (non-fatal).
sweepDeadLetters().catch((err: unknown) => {
  log.error("dead letter sweep failed at startup", {
    error: err instanceof Error ? err.message : String(err),
  });
});

async function handleWebhook(
  req: Request,
  webhooks: ReturnType<typeof createWebhooks>,
): Promise<Response> {
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
