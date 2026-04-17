import { loadAllowlist, loadConfig } from "../config";
import { createOctokit } from "../github";
import { log } from "./logger";
import { createWebhooks } from "./webhooks";

const config = loadConfig();
const allowlist = loadAllowlist(config.reposPath);
const octokit = createOctokit(config.githubPat);
const webhooks = createWebhooks(config.githubWebhookSecret, {
  allowlist,
  octokit,
});

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
  allowlistedRepos: Object.keys(allowlist.all()).length,
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
    if (message.includes("signature does not match")) {
      log.warn("webhook signature rejected", { deliveryId: id });
      return new Response("invalid signature", { status: 401 });
    }
    log.error("webhook processing error", { deliveryId: id, error: message });
    return new Response("processing error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
}
