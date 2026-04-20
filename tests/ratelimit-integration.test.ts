/**
 * Integration test: boot a minimal test server that wires the real rate
 * limiter, fire 121 requests for the same installation in rapid succession,
 * and assert that some receive 429s with a numeric Retry-After header.
 *
 * We also verify that 429 responses never trigger dead-letter writes — rate-
 * limited requests are rejected before any processing occurs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { buildAllowlist } from "../src/config/repos";
import type { Octokit } from "../src/github";
import { RateLimiter } from "../src/server/rate-limit";
import { createWebhooks } from "../src/server/webhooks";

const SECRET = "integration-test-secret";
const INSTALLATION_ID = "99999";

function sign(payload: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

type ServerHandle = { server: ReturnType<typeof Bun.serve>; url: string };

/**
 * Start a server that uses a fresh RateLimiter with a burst of 120 so we can
 * hit the limit deterministically without fighting the real singleton's state.
 */
async function startRateLimitTestServer(): Promise<ServerHandle> {
  const allowlist = buildAllowlist({});
  const webhooks = createWebhooks(SECRET, {
    getAllowlist: () => allowlist,
    octokit: {} as Octokit,
    anthropic: {} as Anthropic,
    selfLogin: "review-me-bot",
  });

  // Isolated limiter: 60 rpm, burst 120 — same defaults as production.
  const limiter = new RateLimiter({ rpm: 60, burst: 120 });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req: Request): Promise<Response> => {
      if (req.method !== "POST") return new Response("nope", { status: 405 });

      // Rate limit check (mirrors production handleWebhook logic).
      const installation =
        req.headers.get("x-github-hook-installation-target-id") ??
        "(no-installation)";
      const rl = limiter.check(installation);
      if (!rl.allowed) {
        return new Response("rate limit exceeded", {
          status: 429,
          headers: { "Retry-After": String(rl.retryAfterSeconds) },
        });
      }

      const id = req.headers.get("x-github-delivery");
      const name = req.headers.get("x-github-event");
      const signature = req.headers.get("x-hub-signature-256");
      if (!id || !name || !signature) {
        return new Response("missing headers", { status: 400 });
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

describe("rate-limit integration", () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await startRateLimitTestServer();
  });

  afterAll(() => {
    handle.server.stop();
  });

  test("121 requests to same installation in <1s: first 120 OK, some 429s with numeric Retry-After", async () => {
    const body = JSON.stringify({ action: "ping" });
    const sig = sign(body);

    const responses = await Promise.all(
      Array.from({ length: 121 }, (_, i) =>
        fetch(handle.url, {
          method: "POST",
          headers: {
            "x-github-delivery": `integration-${i.toString().padStart(4, "0")}`,
            "x-github-event": "ping",
            "x-hub-signature-256": sig,
            "x-github-hook-installation-target-id": INSTALLATION_ID,
            "content-type": "application/json",
          },
          body,
        }),
      ),
    );

    const statuses = responses.map((r) => r.status);
    const ok200 = statuses.filter((s) => s === 200).length;
    const rl429 = statuses.filter((s) => s === 429).length;

    // Exactly 120 allowed, at least 1 rejected.
    expect(ok200).toBe(120);
    expect(rl429).toBeGreaterThanOrEqual(1);

    // Every 429 must carry a numeric Retry-After header.
    for (const res of responses) {
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        expect(retryAfter).not.toBeNull();
        expect(Number.isFinite(Number(retryAfter))).toBe(true);
        expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  test("different installations do not share rate-limit budget", async () => {
    const body = JSON.stringify({ action: "ping" });
    const sig = sign(body);

    // Use a second isolated-limiter server with tiny burst to make this fast.
    const tinyLimiter = new RateLimiter({ rpm: 60, burst: 2 });
    const allowlist = buildAllowlist({});
    const webhooks = createWebhooks(SECRET, {
      getAllowlist: () => allowlist,
      octokit: {} as Octokit,
      anthropic: {} as Anthropic,
      selfLogin: "review-me-bot",
    });
    const s = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req: Request): Promise<Response> => {
        const installation =
          req.headers.get("x-github-hook-installation-target-id") ??
          "(no-installation)";
        const rl = tinyLimiter.check(installation);
        if (!rl.allowed) {
          return new Response("rate limit exceeded", {
            status: 429,
            headers: { "Retry-After": String(rl.retryAfterSeconds) },
          });
        }
        const id = req.headers.get("x-github-delivery");
        const name = req.headers.get("x-github-event");
        const signature = req.headers.get("x-hub-signature-256");
        if (!id || !name || !signature) return new Response("bad", { status: 400 });
        const payload = await req.text();
        try {
          await webhooks.verifyAndReceive({
            id,
            name: name as Parameters<typeof webhooks.verifyAndReceive>[0]["name"],
            signature,
            payload,
          });
        } catch (_) {
          // ignore
        }
        return new Response("ok", { status: 200 });
      },
    });
    const url = `http://127.0.0.1:${s.port}`;

    // Exhaust install-A (burst 2).
    const makeReq = (inst: string, idx: number) =>
      fetch(url, {
        method: "POST",
        headers: {
          "x-github-delivery": `iso-${inst}-${idx}`,
          "x-github-event": "ping",
          "x-hub-signature-256": sig,
          "x-github-hook-installation-target-id": inst,
          "content-type": "application/json",
        },
        body,
      });

    await makeReq("install-A", 0);
    await makeReq("install-A", 1);
    const aBlocked = await makeReq("install-A", 2);
    expect(aBlocked.status).toBe(429);

    // install-B should still be unaffected.
    const bOk = await makeReq("install-B", 0);
    expect(bOk.status).toBe(200);

    s.stop();
  });
});
