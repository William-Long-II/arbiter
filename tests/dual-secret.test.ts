/**
 * Tests for dual-secret webhook verification (issue #46).
 *
 * We build a test HTTP server that mirrors the production handleWebhook
 * dual-secret logic without importing src/server/index.ts (which has
 * top-level await + real config loading + server startup).
 *
 * The logic under test:
 *   - Try primary secret first (timingSafeEqual HMAC).
 *   - If primary fails and secondary is set, try secondary.
 *   - Log evt:webhook.secret_secondary_used when secondary verifies.
 *   - Return 401 only when both fail.
 *   - Dispatch via the matching Webhooks instance.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { buildAllowlist } from "../src/config/repos";
import type { Octokit } from "../src/github";
import { registry } from "../src/server/metrics";
import { createWebhooks } from "../src/server/webhooks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET_A = "secret-alpha-primary";
const SECRET_B = "secret-beta-secondary";
const SECRET_WRONG = "totally-wrong-secret";

function sign(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/**
 * Timing-safe HMAC-SHA256 comparison — mirrors production verifyHmac in
 * src/server/index.ts. Kept in sync manually; any divergence is a bug.
 */
function verifyHmac(payload: string, signature: string, secret: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

const KNOWN_EVENTS = new Set([
  "pull_request",
  "check_suite",
  "issue_comment",
  "pull_request_review_comment",
  "ping",
]);

/** Read the current counter value for a given slot label from the registry. */
function getSecretUsedCount(slot: "primary" | "secondary"): number {
  const rendered = registry.render();
  const prefix = `reviewme_webhook_secret_used_total{slot="${slot}"}`;
  const line = rendered.split("\n").find((l) => l.startsWith(prefix));
  if (!line) return 0;
  return Number(line.split(" ")[1] ?? "0");
}

/** Build one Webhooks instance with stub deps. */
function makeWebhooks(secret: string) {
  const allowlist = buildAllowlist({});
  return createWebhooks(secret, {
    getAllowlist: () => allowlist,
    octokit: {} as Octokit,
    anthropic: {} as Anthropic,
    selfLogin: "review-me-bot",
  });
}

type DualSecretConfig = {
  primarySecret: string;
  secondarySecret?: string;
};

type ServerHandle = { server: ReturnType<typeof Bun.serve>; url: string };

/**
 * Builds a minimal HTTP server that implements the dual-secret pre-verify
 * logic from handleWebhook, wired to real createWebhooks instances.
 *
 * Also increments reviewme_webhook_secret_used_total{slot} so we can assert
 * that the right counter was bumped.
 */
function buildDualSecretServer(cfg: DualSecretConfig): ServerHandle {
  const primary = makeWebhooks(cfg.primarySecret);
  const secondary = cfg.secondarySecret ? makeWebhooks(cfg.secondarySecret) : null;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req: Request): Promise<Response> => {
      if (req.method !== "POST") return new Response("nope", { status: 405 });

      const id = req.headers.get("x-github-delivery");
      const name = req.headers.get("x-github-event");
      const signature = req.headers.get("x-hub-signature-256");

      if (!id || !name || !signature) {
        return new Response("missing required headers", { status: 400 });
      }

      if (!KNOWN_EVENTS.has(name)) {
        return new Response("unknown event", { status: 400 });
      }

      const payload = await req.text();

      // --- Dual-secret pre-verify (mirrors src/server/index.ts handleWebhook) ---
      let matchedWebhooks: ReturnType<typeof makeWebhooks>;
      let secretSlot: "primary" | "secondary";

      if (verifyHmac(payload, signature, cfg.primarySecret)) {
        matchedWebhooks = primary;
        secretSlot = "primary";
      } else if (
        secondary !== null &&
        cfg.secondarySecret !== undefined &&
        verifyHmac(payload, signature, cfg.secondarySecret)
      ) {
        matchedWebhooks = secondary;
        secretSlot = "secondary";
        // Mirror the production log so assertions on the log path are visible.
        console.log(JSON.stringify({ evt: "webhook.secret_secondary_used", delivery_id: id }));
      } else {
        return new Response("invalid signature", { status: 401 });
      }

      registry.incrementCounter("reviewme_webhook_secret_used_total", { slot: secretSlot });

      try {
        await matchedWebhooks.verifyAndReceive({
          id,
          name: name as Parameters<typeof matchedWebhooks.verifyAndReceive>[0]["name"],
          signature,
          payload,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("signature does not match")) {
          return new Response("invalid signature", { status: 401 });
        }
        return new Response("error", { status: 500 });
      }

      return new Response("ok", { status: 200 });
    },
  });

  return { server, url: `http://127.0.0.1:${server.port}` };
}

const PING_PAYLOAD = JSON.stringify({ zen: "dual secret test" });

// ---------------------------------------------------------------------------
// Tests: primary secret only (no secondary)
// ---------------------------------------------------------------------------

describe("dual-secret: primary only (no secondary configured)", () => {
  let handle: ServerHandle;

  beforeEach(() => {
    handle = buildDualSecretServer({ primarySecret: SECRET_A });
  });

  afterEach(() => {
    handle.server.stop();
  });

  test("returns 200 for a request signed with the primary secret", async () => {
    const before = getSecretUsedCount("primary");
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "dual-primary-only-001",
        "x-github-event": "ping",
        "x-hub-signature-256": sign(PING_PAYLOAD, SECRET_A),
      },
      body: PING_PAYLOAD,
    });
    expect(res.status).toBe(200);
    expect(getSecretUsedCount("primary")).toBe(before + 1);
  });

  test("returns 401 for a request signed with an unknown secret", async () => {
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "dual-primary-only-002",
        "x-github-event": "ping",
        "x-hub-signature-256": sign(PING_PAYLOAD, SECRET_WRONG),
      },
      body: PING_PAYLOAD,
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 for a completely malformed signature", async () => {
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "dual-primary-only-003",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=notahex!!!",
      },
      body: PING_PAYLOAD,
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Tests: primary + secondary configured
// ---------------------------------------------------------------------------

describe("dual-secret: primary + secondary configured", () => {
  let handle: ServerHandle;

  beforeEach(() => {
    handle = buildDualSecretServer({ primarySecret: SECRET_A, secondarySecret: SECRET_B });
  });

  afterEach(() => {
    handle.server.stop();
  });

  test("returns 200 and increments primary metric for primary-signed request", async () => {
    const before = getSecretUsedCount("primary");
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "dual-both-001",
        "x-github-event": "ping",
        "x-hub-signature-256": sign(PING_PAYLOAD, SECRET_A),
      },
      body: PING_PAYLOAD,
    });
    expect(res.status).toBe(200);
    expect(getSecretUsedCount("primary")).toBe(before + 1);
  });

  test("returns 200 and increments secondary metric for secondary-signed request", async () => {
    const before = getSecretUsedCount("secondary");
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "dual-both-002",
        "x-github-event": "ping",
        "x-hub-signature-256": sign(PING_PAYLOAD, SECRET_B),
      },
      body: PING_PAYLOAD,
    });
    expect(res.status).toBe(200);
    expect(getSecretUsedCount("secondary")).toBe(before + 1);
  });

  test("returns 401 when neither secret matches", async () => {
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "dual-both-003",
        "x-github-event": "ping",
        "x-hub-signature-256": sign(PING_PAYLOAD, SECRET_WRONG),
      },
      body: PING_PAYLOAD,
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Tests: mid-rotation scenario
// ---------------------------------------------------------------------------

describe("dual-secret: mid-rotation swap", () => {
  test("A succeeds before swap, B succeeds with secondary, A fails after swap", async () => {
    // Phase 1: primary=A, secondary=B (rotation in progress)
    const phase1 = buildDualSecretServer({ primarySecret: SECRET_A, secondarySecret: SECRET_B });

    // Request signed with A (primary) should succeed.
    const resA = await fetch(phase1.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "rotation-phase1-A",
        "x-github-event": "ping",
        "x-hub-signature-256": sign(PING_PAYLOAD, SECRET_A),
      },
      body: PING_PAYLOAD,
    });
    expect(resA.status).toBe(200);

    // Request signed with B (secondary) should succeed.
    const resB = await fetch(phase1.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "rotation-phase1-B",
        "x-github-event": "ping",
        "x-hub-signature-256": sign(PING_PAYLOAD, SECRET_B),
      },
      body: PING_PAYLOAD,
    });
    expect(resB.status).toBe(200);

    phase1.server.stop();

    // Phase 2: swap complete — primary=B, secondary removed.
    const phase2 = buildDualSecretServer({ primarySecret: SECRET_B });

    // Request signed with B should succeed (now primary).
    const resB2 = await fetch(phase2.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "rotation-phase2-B",
        "x-github-event": "ping",
        "x-hub-signature-256": sign(PING_PAYLOAD, SECRET_B),
      },
      body: PING_PAYLOAD,
    });
    expect(resB2.status).toBe(200);

    // Request signed with A should now fail (A is no longer accepted).
    const resA2 = await fetch(phase2.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "rotation-phase2-A",
        "x-github-event": "ping",
        "x-hub-signature-256": sign(PING_PAYLOAD, SECRET_A),
      },
      body: PING_PAYLOAD,
    });
    expect(resA2.status).toBe(401);

    phase2.server.stop();
  });
});

// ---------------------------------------------------------------------------
// Regression: secondary unset is byte-identical to single-secret behaviour
// ---------------------------------------------------------------------------

describe("dual-secret: regression — secondary unset", () => {
  let handle: ServerHandle;

  beforeEach(() => {
    handle = buildDualSecretServer({ primarySecret: SECRET_A });
  });

  afterEach(() => {
    handle.server.stop();
  });

  test("valid primary request accepted (regression)", async () => {
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "regression-001",
        "x-github-event": "ping",
        "x-hub-signature-256": sign(PING_PAYLOAD, SECRET_A),
      },
      body: PING_PAYLOAD,
    });
    expect(res.status).toBe(200);
  });

  test("invalid signature rejected (regression)", async () => {
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "regression-002",
        "x-github-event": "ping",
        "x-hub-signature-256": sign(PING_PAYLOAD, SECRET_WRONG),
      },
      body: PING_PAYLOAD,
    });
    expect(res.status).toBe(401);
  });

  test("missing headers rejected with 400 (regression)", async () => {
    const res = await fetch(handle.url, {
      method: "POST",
      body: PING_PAYLOAD,
    });
    expect(res.status).toBe(400);
  });
});
