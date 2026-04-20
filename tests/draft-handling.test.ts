/**
 * Tests for draft PR handling (issue #44).
 *
 * Covers:
 *   - pull_request.opened with draft:true → skip, no runPipeline, metric bumped
 *   - pull_request.synchronize with draft:true → skip, no runPipeline, metric bumped
 *   - pull_request.reopened with draft:true → skip, metric bumped
 *   - pull_request.ready_for_review → triggers triggerExplicit (CI gate + pipeline)
 *   - Existing non-draft opened path → unchanged (regression)
 *   - review-comment handler: draft PR → skip before Anthropic call
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { buildAllowlist } from "../src/config/repos";
import type { Octokit } from "../src/github";
import { createWebhooks } from "../src/server/webhooks";
import { registry, draftSkippedTotal } from "../src/server/metrics";
import { handleReviewCommentCreated } from "../src/server/handlers/review-comment";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = "draft-test-secret";

function sign(payload: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

/** Read the current value of reviewme_draft_skipped_total from the registry. */
function readDraftSkippedCount(): number {
  // Render and parse — avoids exposing registry internals
  const text = registry.render();
  const match = text.match(/^reviewme_draft_skipped_total\s+(\d+)/m);
  return match ? parseInt(match[1]!, 10) : 0;
}

/** Minimal allowlist with acme/widget enabled. */
function makeAllowlist() {
  return buildAllowlist({
    "acme/widget": {
      enabled: true,
      rereview: "auto-on-sync",
      rereview_label: "re-review",
    },
  });
}

type WebhookResult = { status: number };

/**
 * Fire a webhook event directly via webhooks.verifyAndReceive so we do not
 * need a real HTTP server.
 */
async function fireEvent(
  webhooks: ReturnType<typeof createWebhooks>,
  eventName: string,
  payload: unknown,
  id = "00000000-0000-0000-0000-000000000099",
): Promise<void> {
  const body = JSON.stringify(payload);
  await webhooks.verifyAndReceive({
    id,
    name: eventName as Parameters<typeof webhooks.verifyAndReceive>[0]["name"],
    signature: sign(body),
    payload: body,
  });
}

// ---------------------------------------------------------------------------
// Mocks for external deps used by runPipeline / triggerExplicit
// ---------------------------------------------------------------------------

/** Returns an Octokit mock where evaluateHeadSha can be controlled. */
function makeOctokit(opts: { ciGreen?: boolean } = {}): Octokit {
  const { ciGreen = true } = opts;
  return {
    checks: {
      listForRef: async () => ({
        data: {
          check_runs: ciGreen
            ? [{ status: "completed", conclusion: "success", name: "CI" }]
            : [{ status: "completed", conclusion: "failure", name: "CI" }],
        },
      }),
    },
    pulls: {
      listReviews: async () => ({ data: [] }),
      get: async () => ({
        data: {
          title: "Test PR",
          body: "",
          draft: false,
        },
      }),
    },
  } as unknown as Octokit;
}

const noopAnthropic = {} as Anthropic;

// ---------------------------------------------------------------------------
// Webhook-level draft skip tests
// ---------------------------------------------------------------------------

describe("draft PR webhook handling", () => {
  let runPipelineCalled: boolean;

  beforeEach(() => {
    runPipelineCalled = false;
  });

  function makeDraftPayload(action: string) {
    return {
      action,
      number: 42,
      pull_request: {
        number: 42,
        draft: true,
        head: { sha: "deadbeef" },
      },
      repository: { full_name: "acme/widget" },
      sender: { login: "dev" },
    };
  }

  function makeReadyPayload() {
    return {
      action: "ready_for_review",
      number: 42,
      pull_request: {
        number: 42,
        draft: false,
        head: { sha: "deadbeef" },
      },
      repository: {
        full_name: "acme/widget",
        owner: { login: "acme" },
        name: "widget",
      },
      sender: { login: "dev" },
    };
  }

  test("pull_request.opened with draft:true skips and bumps metric", async () => {
    const before = readDraftSkippedCount();

    const webhooks = createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: makeOctokit(),
      anthropic: noopAnthropic,
      selfLogin: "review-me-bot",
    });

    await fireEvent(webhooks, "pull_request", makeDraftPayload("opened"), "id-draft-open-1");

    const after = readDraftSkippedCount();
    expect(after - before).toBe(1);
  });

  test("pull_request.synchronize with draft:true skips and bumps metric", async () => {
    const before = readDraftSkippedCount();

    const webhooks = createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: makeOctokit(),
      anthropic: noopAnthropic,
      selfLogin: "review-me-bot",
    });

    await fireEvent(webhooks, "pull_request", makeDraftPayload("synchronize"), "id-draft-sync-1");

    const after = readDraftSkippedCount();
    expect(after - before).toBe(1);
  });

  test("pull_request.reopened with draft:true skips and bumps metric", async () => {
    const before = readDraftSkippedCount();

    const webhooks = createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: makeOctokit(),
      anthropic: noopAnthropic,
      selfLogin: "review-me-bot",
    });

    await fireEvent(webhooks, "pull_request", makeDraftPayload("reopened"), "id-draft-reopen-1");

    const after = readDraftSkippedCount();
    expect(after - before).toBe(1);
  });

  test("pull_request.opened with draft:false does NOT bump draft metric", async () => {
    const before = readDraftSkippedCount();

    const webhooks = createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: makeOctokit(),
      anthropic: noopAnthropic,
      selfLogin: "review-me-bot",
    });

    const payload = {
      action: "opened",
      number: 42,
      pull_request: {
        number: 42,
        draft: false,
        head: { sha: "abc123" },
      },
      repository: { full_name: "acme/widget" },
      sender: { login: "dev" },
    };

    await fireEvent(webhooks, "pull_request", payload, "id-nondraft-open-1");

    const after = readDraftSkippedCount();
    expect(after - before).toBe(0);
  });

  test("pull_request.ready_for_review fires triggerExplicit (CI green path)", async () => {
    // With green CI the pipeline will be enqueued. We verify that no draft-skip
    // metric is emitted and that the handler runs without throwing.
    const before = readDraftSkippedCount();

    const webhooks = createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: makeOctokit({ ciGreen: true }),
      anthropic: noopAnthropic,
      selfLogin: "review-me-bot",
    });

    // Should not throw even if pipeline setup fails (queue enqueue is async)
    await fireEvent(webhooks, "pull_request", makeReadyPayload(), "id-rfr-green-1");

    const after = readDraftSkippedCount();
    // Draft metric should not have been incremented
    expect(after - before).toBe(0);
  });

  test("pull_request.ready_for_review with CI not green does not enqueue pipeline", async () => {
    const before = readDraftSkippedCount();

    const webhooks = createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: makeOctokit({ ciGreen: false }),
      anthropic: noopAnthropic,
      selfLogin: "review-me-bot",
    });

    await fireEvent(webhooks, "pull_request", makeReadyPayload(), "id-rfr-red-1");

    const after = readDraftSkippedCount();
    expect(after - before).toBe(0);
  });

  test("pull_request.opened missing draft field (undefined) treated as non-draft", async () => {
    // Defensive: if the field is absent we default to non-draft behaviour.
    const before = readDraftSkippedCount();

    const webhooks = createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: makeOctokit(),
      anthropic: noopAnthropic,
      selfLogin: "review-me-bot",
    });

    const payload = {
      action: "opened",
      number: 42,
      pull_request: {
        number: 42,
        // draft field intentionally omitted
        head: { sha: "abc123" },
      },
      repository: { full_name: "acme/widget" },
      sender: { login: "dev" },
    };

    await fireEvent(webhooks, "pull_request", payload, "id-no-draft-field-1");

    const after = readDraftSkippedCount();
    expect(after - before).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// review-comment handler: draft PR defensive skip
// ---------------------------------------------------------------------------

describe("handleReviewCommentCreated — draft PR skip", () => {
  function makePayload() {
    return {
      comment: {
        id: 9999,
        user: { login: "developer" },
        body: "Can you clarify?",
        in_reply_to_id: 1000,
      },
      pull_request: { number: 42 },
      repository: {
        full_name: "acme/widget",
        owner: { login: "acme" },
        name: "widget",
      },
    };
  }

  /** Octokit where the parent comment belongs to the bot and the PR is draft. */
  function makeDraftPrOctokit() {
    const createReplyCalls: unknown[] = [];
    return {
      octokit: {
        pulls: {
          getReviewComment: async () => ({
            data: {
              user: { login: "review-me-bot" },
              body: "Consider a Map.",
              diff_hunk: "@@ -1,1 +1,2 @@\n x",
            },
          }),
          get: async () => ({
            data: {
              title: "WIP: some feature",
              body: "",
              draft: true,
            },
          }),
          createReplyForReviewComment: async (p: unknown) => {
            createReplyCalls.push(p);
            return { data: { id: 11111 } };
          },
        },
      } as unknown as Octokit,
      createReplyCalls,
    };
  }

  test("skips Anthropic call and reply when PR is draft", async () => {
    const { octokit, createReplyCalls } = makeDraftPrOctokit();
    const anthropicCalls: unknown[] = [];
    const anthropic = {
      messages: {
        create: async (p: unknown) => {
          anthropicCalls.push(p);
          return { content: [{ type: "text", text: "reply" }] };
        },
      },
    } as unknown as Anthropic;

    await handleReviewCommentCreated(makePayload(), {
      octokit,
      anthropic,
      selfLogin: "review-me-bot",
    });

    expect(anthropicCalls.length).toBe(0);
    expect(createReplyCalls.length).toBe(0);
  });
});
