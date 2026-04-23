import type { Store } from "../../state/db.ts";
import type { Runtime, WebhookPullRef } from "../runtime.ts";
import { verifyWebhookSignature } from "../../webhook/verify.ts";
import { extractWebhookTarget } from "../../webhook/extract.ts";
import { log } from "../../log.ts";

/**
 * GitHub webhook ingest. Contract:
 *
 *   - 401: signature missing or doesn't verify against GITHUB_WEBHOOK_SECRET.
 *   - 503: GITHUB_WEBHOOK_SECRET is unset — we refuse to "accept" anonymous
 *          POSTs since the body is unauthenticated.
 *   - 400: body isn't valid JSON (every real GitHub delivery is).
 *   - 200: accepted — either enqueued for review, or a duplicate delivery
 *          (we've seen this X-GitHub-Delivery before), or an event we don't
 *          act on (ping, issues, etc.). Always 200 so GitHub doesn't retry.
 *
 * The route is OUTSIDE the session-auth middleware (webhook signature IS
 * the auth). It's also exempt from same-origin CSRF — GitHub will never
 * send an Origin header matching our host.
 */
export async function webhookRoute(args: {
  req: Request;
  store: Store;
  runtime: Runtime;
  secret: string;
}): Promise<Response> {
  const { req, store, runtime, secret } = args;

  if (!secret) {
    // Operator hasn't wired the webhook secret. Don't silently accept — that
    // would let anyone on the Internet POST a forged payload.
    log.warn("webhook.secret_unset", {});
    return plain(503, "webhook ingest disabled: set GITHUB_WEBHOOK_SECRET");
  }

  // Read raw body for HMAC — parsing first and re-stringifying would change
  // whitespace and break the signature.
  const body = await req.text();

  const signature = req.headers.get("x-hub-signature-256");
  if (!verifyWebhookSignature({ body, secret, signatureHeader: signature })) {
    store.recordEvent({
      level: "warn",
      kind: "webhook.signature_invalid",
      message: "Rejected webhook: signature missing or did not verify",
    });
    return plain(401, "invalid signature");
  }

  const deliveryId = req.headers.get("x-github-delivery") ?? "";
  const event = req.headers.get("x-github-event");
  if (!deliveryId) {
    // Legitimate GitHub deliveries always set this. Missing is either
    // someone poking the endpoint directly or a broken tunnel; reject
    // with a generic 400 rather than accepting and ballooning the dedup
    // table with a zero-id row.
    return plain(400, "missing X-GitHub-Delivery");
  }

  // Insert-or-ignore returns true when the row already existed. A duplicate
  // is NOT an error — GitHub retries on any 5xx, so the same delivery lands
  // more than once when we're slow. 200 OK + no further work.
  const duplicate = store.recordWebhookDelivery({
    delivery_id: deliveryId,
    event_type: event ?? "(none)",
  });
  if (duplicate) {
    log.info("webhook.duplicate", { deliveryId, event });
    store.recordEvent({
      level: "info",
      kind: "webhook.duplicate",
      message: `Duplicate delivery ${deliveryId} (${event}) ignored`,
    });
    return plain(200, "duplicate");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (e) {
    return plain(400, `invalid JSON: ${(e as Error).message}`);
  }

  const target = extractWebhookTarget({ event, payload });
  if (target.kind === "ignored") {
    log.info("webhook.ignored", { deliveryId, event, reason: target.reason });
    store.recordEvent({
      level: "info",
      kind: "webhook.ignored",
      message: `Webhook ignored: ${target.reason}`,
      payload: { deliveryId, event },
    });
    return plain(200, "ignored");
  }

  // pull_request opened / synchronize / reopened — enqueue and nudge the loop.
  const ref: WebhookPullRef = {
    repo: target.repo,
    number: target.number,
    head_sha: target.head_sha,
    source: "webhook",
  };
  runtime.webhookQueue.push(ref);
  runtime.wakeRequested = true;

  const repoSlug = `${target.repo.owner}/${target.repo.name}`;
  log.info("webhook.enqueued", {
    deliveryId,
    event,
    action: target.action,
    repo: repoSlug,
    pr: target.number,
  });
  store.recordEvent({
    level: "info",
    kind: "webhook.enqueued",
    message: `Webhook enqueued ${repoSlug}#${target.number} for review (${target.action})`,
    repo: repoSlug,
    prNumber: target.number,
    headSha: target.head_sha,
    payload: { deliveryId, event, action: target.action },
  });
  return plain(200, "enqueued");
}

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
