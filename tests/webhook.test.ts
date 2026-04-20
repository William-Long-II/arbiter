import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { buildAllowlist } from "../src/config/repos";
import type { Octokit } from "../src/github";
import { createWebhooks } from "../src/server/webhooks";

const SECRET = "test-secret";

function sign(payload: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

type ServerHandle = { server: ReturnType<typeof Bun.serve>; url: string };

async function startTestServer(): Promise<ServerHandle> {
  const webhooks = createWebhooks(SECRET, {
    allowlist: buildAllowlist({}),
    octokit: {} as Octokit,
    anthropic: {} as Anthropic,
    selfLogin: "reviewme-bot",
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      if (req.method !== "POST") return new Response("nope", { status: 405 });
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

describe("webhook endpoint", () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await startTestServer();
  });

  afterAll(() => {
    handle.server.stop();
  });

  test("rejects request without signature headers", async () => {
    const res = await fetch(handle.url, { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
  });

  test("rejects invalid signature with 401", async () => {
    const body = JSON.stringify({ hello: "world" });
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "00000000-0000-0000-0000-000000000001",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=deadbeef",
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  test("accepts valid pull_request.opened payload (not allowlisted)", async () => {
    const payload = {
      action: "opened",
      number: 42,
      pull_request: {
        number: 42,
        head: { sha: "abc123" },
      },
      repository: { full_name: "acme/widget" },
      sender: { login: "someone" },
    };
    const body = JSON.stringify(payload);
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "00000000-0000-0000-0000-000000000002",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(body),
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  test("accepts valid check_suite.completed payload (not allowlisted)", async () => {
    const payload = {
      action: "completed",
      check_suite: {
        conclusion: "success",
        head_sha: "abc123",
        pull_requests: [{ number: 42 }],
      },
      repository: { full_name: "acme/widget" },
      sender: { login: "ci" },
    };
    const body = JSON.stringify(payload);
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "00000000-0000-0000-0000-000000000003",
        "x-github-event": "check_suite",
        "x-hub-signature-256": sign(body),
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(200);
  });

  test("ignores unhandled events without erroring", async () => {
    const body = JSON.stringify({ zen: "Keep it logically awesome." });
    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "00000000-0000-0000-0000-000000000004",
        "x-github-event": "ping",
        "x-hub-signature-256": sign(body),
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(200);
  });
});
