import { loadConfig } from "../config";
import { log } from "./logger";
import { createWebhooks } from "./webhooks";

const config = loadConfig();
const webhooks = createWebhooks(config.githubWebhookSecret);

const server = Bun.serve({
  port: config.port,
  hostname: config.hostname,
  routes: {
    "/health": new Response("ok"),
    "/ready": new Response("ok"),
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

  const payload = await req.text();

  try {
    await webhooks.verifyAndReceive({
      id,
      name: name as Parameters<typeof webhooks.verifyAndReceive>[0]["name"],
      signature,
      payload,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Signature failures throw with a specific message; treat as 401.
    if (message.includes("signature does not match")) {
      log.warn("webhook signature rejected", { deliveryId: id });
      return new Response("invalid signature", { status: 401 });
    }
    log.error("webhook processing error", { deliveryId: id, error: message });
    return new Response("processing error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
}
