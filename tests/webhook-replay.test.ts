/**
 * Integration tests for HMAC replay protection and unknown-event validation
 * (issue #22).
 *
 * We build a test HTTP server that wires together:
 *   - @octokit/webhooks for signature verification + dispatch
 *   - ReplayCache for nonce deduplication
 *   - KNOWN_EVENTS allow-set for event validation
 *
 * This mirrors the production handleWebhook logic without importing
 * src/server/index.ts (which has top-level await and starts a real server).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { Webhooks } from "@octokit/webhooks";
import { buildAllowlist } from "../src/config/repos";
import type { Octokit } from "../src/github";
import { ReplayCache } from "../src/server/replay-cache";
import { createWebhooks } from "../src/server/webhooks";

const SECRET = "test-secret";

// Events that the bot recognises — kept in sync with src/server/index.ts.
const KNOWN_EVENTS = new Set([
  "pull_request",
  "check_suite",
  "issue_comment",
  "pull_request_review_comment",
  "ping",
]);

function sign(payload: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

type ServerHandle = {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  cache: ReplayCache;
};

function buildTestServer(cacheOpts: ConstructorParameters<typeof ReplayCache>[0] = {}): ServerHandle {
  const cache = new ReplayCache(cacheOpts);
  const allowlist = buildAllowlist({});
  const webhooks = createWebhooks(SECRET, {
    getAllowlist: () => allowlist,
    octokit: {} as Octokit,
    anthropic: {} as Anthropic,
    selfLogin: "review-me-bot",
  });

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

      // Unknown-event guard (mirrors KNOWN_EVENTS in src/server/index.ts).
      if (!KNOWN_EVENTS.has(name)) {
        return new Response("unknown event", { status: 400 });
      }

      const payload = await req.text();

      // Pre-verify signature before cache insertion.
      const valid = await webhooks.verify(payload, signature);
      if (!valid) {
        return new Response("invalid signature", { status: 401 });
      }

      // Replay check.
      const { fresh } = cache.tryInsert(id);
      if (!fresh) {
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
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("signature does not match")) {
          return new Response("invalid signature", { status: 401 });
        }
        return new Response("error", { status: 500 });
      }

      return new Response("ok", { status: 200 });
    },
  });

  return { server, url: `http://127.0.0.1:${server.port}`, cache };
}

// ---------------------------------------------------------------------------
// Integration: replay detection
// ---------------------------------------------------------------------------

describe("replay protection integration", () => {
  let handle: ServerHandle;

  beforeEach(() => {
    handle = buildTestServer();
  });

  afterEach(() => {
    handle.server.stop();
  });

  test("first signed request returns 200", async () => {
    const body = JSON.stringify({ zen: "Speak like a human." });
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "replay-test-0001",
        "x-github-event": "ping",
        "x-hub-signature-256": sign(body),
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  test("second identical signed request returns 409 (replay)", async () => {
    const body = JSON.stringify({ zen: "Speak like a human." });
    const headers = {
      "x-github-delivery": "replay-test-0002",
      "x-github-event": "ping",
      "x-hub-signature-256": sign(body),
    };

    const first = await fetch(handle.url, { method: "POST", headers, body });
    expect(first.status).toBe(200);

    const second = await fetch(handle.url, { method: "POST", headers, body });
    expect(second.status).toBe(409);
  });

  test("no false positives: two different delivery IDs with same payload both succeed", async () => {
    const body = JSON.stringify({ zen: "Same payload, different IDs." });
    const sig = sign(body);

    const res1 = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "unique-delivery-A",
        "x-github-event": "ping",
        "x-hub-signature-256": sig,
      },
      body,
    });
    expect(res1.status).toBe(200);

    const res2 = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "unique-delivery-B",
        "x-github-event": "ping",
        "x-hub-signature-256": sig,
      },
      body,
    });
    expect(res2.status).toBe(200);
  });

  test("invalid signature returns 401 even for a fresh delivery ID", async () => {
    const body = JSON.stringify({ action: "opened" });
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "bad-sig-delivery",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=deadbeefdeadbeef",
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  test("invalid signature does NOT insert delivery ID into the cache", async () => {
    const body = JSON.stringify({ zen: "test" });
    const deliveryId = "cache-not-poisoned";

    // First attempt with bad signature — should fail 401.
    const bad = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": deliveryId,
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=badbadbadbad",
      },
      body,
    });
    expect(bad.status).toBe(401);

    // Now the same ID with a valid signature — must succeed (not 409).
    const good = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": deliveryId,
        "x-github-event": "ping",
        "x-hub-signature-256": sign(body),
      },
      body,
    });
    expect(good.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Integration: unknown-event validation
// ---------------------------------------------------------------------------

describe("unknown event validation", () => {
  let handle: ServerHandle;

  beforeEach(() => {
    handle = buildTestServer();
  });

  afterEach(() => {
    handle.server.stop();
  });

  test("unknown event name returns 400", async () => {
    const body = JSON.stringify({ action: "created" });
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "unknown-evt-delivery",
        "x-github-event": "repository",          // not in KNOWN_EVENTS
        "x-hub-signature-256": sign(body),
      },
      body,
    });
    expect(res.status).toBe(400);
  });

  test("known events are accepted normally", async () => {
    for (const evt of ["ping", "pull_request", "check_suite", "issue_comment", "pull_request_review_comment"] as const) {
      const body = JSON.stringify({ action: "opened" });
      const res = await fetch(handle.url, {
        method: "POST",
        headers: {
          "x-github-delivery": `known-evt-${evt}`,
          "x-github-event": evt,
          "x-hub-signature-256": sign(body),
        },
        body,
      });
      // 200 or 500 (missing payload fields for non-ping events) — both mean
      // the event was not rejected at the edge.
      expect([200, 500]).toContain(res.status);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit: TTL expiry via injected clock (no real timers)
// ---------------------------------------------------------------------------

describe("replay cache TTL (fake clock)", () => {
  test("expired delivery ID is treated as fresh on re-insert", () => {
    let fakeNow = 1_000_000;
    const cache = new ReplayCache({ ttlMs: 1_000, now: () => fakeNow });

    const first = cache.tryInsert("ttl-test-id");
    expect(first.fresh).toBe(true);

    const replay = cache.tryInsert("ttl-test-id");
    expect(replay.fresh).toBe(false);

    fakeNow += 1_001; // past TTL
    const afterExpiry = cache.tryInsert("ttl-test-id");
    expect(afterExpiry.fresh).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: restart behaviour (documented note)
// ---------------------------------------------------------------------------

describe("restart behaviour", () => {
  test("new cache instance forgets all previously-seen IDs (restart = amnesia)", () => {
    // This is intentional and accepted as out-of-scope per issue #22.
    // A replay arriving after a process restart within the TTL window will
    // succeed.  The trade-off is documented here.
    const before = new ReplayCache();
    before.tryInsert("post-restart-id");

    const after = new ReplayCache(); // simulates restart
    expect(after.tryInsert("post-restart-id")).toEqual({ fresh: true });
  });
});
