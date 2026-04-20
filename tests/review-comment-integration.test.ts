/**
 * Integration test: boot the webhook handler with mocked deps, send a signed
 * pull_request_review_comment.created fixture, assert one
 * createReplyForReviewComment call.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildAllowlist } from "../src/config/repos";
import type { Octokit } from "../src/github";
import { createWebhooks } from "../src/server/webhooks";

const SECRET = "test-secret-integration";

function sign(payload: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const createReplyCalls: unknown[] = [];
const getReviewCommentCalls: unknown[] = [];

const mockOctokit = {
  pulls: {
    getReviewComment: async (params: unknown) => {
      getReviewCommentCalls.push(params);
      return {
        data: {
          user: { login: "review-me-bot" },
          body: "Consider using a Map here for O(1) lookups.",
          diff_hunk: "@@ -1,5 +1,7 @@\n const x = 1;",
        },
      };
    },
    get: async () => ({
      data: { title: "Add widget caching", body: "Implements WIDGET-42." },
    }),
    createReplyForReviewComment: async (params: unknown) => {
      createReplyCalls.push(params);
      return { data: { id: 11111 } };
    },
  },
} as unknown as Octokit;

const mockAnthropic = {
  messages: {
    create: async () => ({
      content: [{ type: "text", text: "Great question! A Map gives O(1) lookups." }],
    }),
  },
} as unknown as Anthropic;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

type ServerHandle = { server: ReturnType<typeof Bun.serve>; url: string };

async function startTestServer(): Promise<ServerHandle> {
  const allowlist = buildAllowlist({});
  const webhooks = createWebhooks(SECRET, {
    getAllowlist: () => allowlist,
    octokit: mockOctokit,
    anthropic: mockAnthropic,
    selfLogin: "review-me-bot",
  });

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      if (req.method !== "POST") return new Response("nope", { status: 405 });
      const id = req.headers.get("x-github-delivery");
      const name = req.headers.get("x-github-event");
      const signature = req.headers.get("x-hub-signature-256");
      if (!id || !name || !signature)
        return new Response("missing headers", { status: 400 });
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
        if (msg.includes("signature does not match"))
          return new Response("invalid signature", { status: 401 });
        return new Response("error", { status: 500 });
      }
      return new Response("ok", { status: 200 });
    },
  });

  return { server, url: `http://127.0.0.1:${server.port}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pull_request_review_comment integration", () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    handle = await startTestServer();
  });

  afterAll(() => {
    handle.server.stop();
  });

  test("fixture reply on a bot comment → exactly one createReplyForReviewComment call", async () => {
    const fixtureBody = readFileSync(
      resolve(
        import.meta.dir,
        "../fixtures/pull_request_review_comment.created.json",
      ),
      "utf8",
    );

    const priorReplyCalls = createReplyCalls.length;

    const res = await fetch(handle.url, {
      method: "POST",
      headers: {
        "x-github-delivery": "00000000-0000-0000-0000-000000000010",
        "x-github-event": "pull_request_review_comment",
        "x-hub-signature-256": sign(fixtureBody),
        "content-type": "application/json",
      },
      body: fixtureBody,
    });

    expect(res.status).toBe(200);

    // Give the async handler time to complete (it's fire-and-forget in the
    // webhooks library).
    await new Promise((r) => setTimeout(r, 50));

    expect(createReplyCalls.length - priorReplyCalls).toBe(1);
  });
});
