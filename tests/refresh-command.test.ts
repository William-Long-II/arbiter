/**
 * Tests for /review-me refresh slash command (issue #79).
 *
 * Covers:
 *   - parseSlashCommand recognises "refresh" (case-insensitive)
 *   - resultCache.delete removes exactly the targeted key
 *   - Webhook dispatch: resultCache.delete called with correct key,
 *     ack comment posted, re-review pipeline triggered, metric bumped
 *   - /review-me help lists the refresh command
 *   - Bot's own ack comment does not loop back into the handler
 *   - Unknown commands remain "unknown" (regression)
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { buildAllowlist } from "../src/config/repos";
import type { Octokit } from "../src/github";
import { createWebhooks } from "../src/server/webhooks";
import { parseSlashCommand } from "../src/server/triggers";
import { resultCache } from "../src/review/result-cache";
import * as metricsModule from "../src/server/metrics";
import type { RunReviewOutput } from "../src/review/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = "refresh-test-secret";

function sign(payload: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

async function fireEvent(
  webhooks: ReturnType<typeof createWebhooks>,
  eventName: string,
  payload: unknown,
  id = `delivery-${Math.random()}`,
): Promise<void> {
  const body = JSON.stringify(payload);
  await webhooks.verifyAndReceive({
    id,
    name: eventName as Parameters<typeof webhooks.verifyAndReceive>[0]["name"],
    signature: sign(body),
    payload: body,
  });
}

function makeAllowlist() {
  return buildAllowlist({
    "acme/widget": {
      enabled: true,
      rereview: "auto-on-sync" as const,
      rereview_label: "re-review",
    },
  });
}

function makeOutput(summary = "cached result"): RunReviewOutput {
  return {
    result: { verdict: "approve", summary, lineComments: [] },
    warnings: [],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

// ---------------------------------------------------------------------------
// parseSlashCommand — refresh recognition
// ---------------------------------------------------------------------------

describe("parseSlashCommand — refresh", () => {
  test('/review-me refresh → { command: "refresh" }', () => {
    expect(parseSlashCommand("/review-me refresh")).toEqual({
      command: "refresh",
      raw: "/review-me refresh",
    });
  });

  test("case-insensitive: REFRESH", () => {
    const result = parseSlashCommand("/review-me REFRESH");
    expect(result?.command).toBe("refresh");
    expect(result?.raw).toBe("/review-me REFRESH");
  });

  test("case-insensitive: Refresh", () => {
    const result = parseSlashCommand("/review-me Refresh");
    expect(result?.command).toBe("refresh");
  });

  test("refresh at line boundary after preceding text", () => {
    const body = "Some comment.\n/review-me refresh\nTrailing.";
    expect(parseSlashCommand(body)?.command).toBe("refresh");
  });

  test("unknown subcommand still returns unknown (regression)", () => {
    expect(parseSlashCommand("/review-me lol")?.command).toBe("unknown");
  });

  test("refresh inline (not at line boundary) is NOT matched", () => {
    expect(parseSlashCommand("Please /review-me refresh this")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resultCache.delete — unit tests
// ---------------------------------------------------------------------------

describe("resultCache.delete", () => {
  beforeEach(() => {
    resultCache.clear();
  });

  test("delete removes an existing entry", () => {
    const out = makeOutput();
    resultCache.set("acme/widget@sha-del-1", out);
    expect(resultCache.get("acme/widget@sha-del-1")).toBe(out);

    resultCache.delete("acme/widget@sha-del-1");
    expect(resultCache.get("acme/widget@sha-del-1")).toBeUndefined();
    expect(resultCache.size()).toBe(0);
  });

  test("delete on absent key is a no-op", () => {
    expect(() => resultCache.delete("acme/widget@nonexistent")).not.toThrow();
    expect(resultCache.size()).toBe(0);
  });

  test("delete removes only the targeted entry, not siblings", () => {
    resultCache.set("acme/widget@sha-A", makeOutput("A"));
    resultCache.set("acme/widget@sha-B", makeOutput("B"));
    expect(resultCache.size()).toBe(2);

    resultCache.delete("acme/widget@sha-A");

    expect(resultCache.get("acme/widget@sha-A")).toBeUndefined();
    expect(resultCache.get("acme/widget@sha-B")).toBeDefined();
    expect(resultCache.size()).toBe(1);
  });

  test("key format matches ${repoFull}@${headSha}", () => {
    // Verify the key format used by webhooks.ts is the same as result-cache uses.
    const repoFull = "acme/widget";
    const headSha = "deadbeef1234";
    const key = `${repoFull}@${headSha}`;

    resultCache.set(key, makeOutput("cached"));
    expect(resultCache.get(key)).toBeDefined();
    resultCache.delete(key);
    expect(resultCache.get(key)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Webhook dispatch — /review-me refresh
// ---------------------------------------------------------------------------

describe("webhook /review-me refresh dispatch", () => {
  const HEAD_SHA = "cafebabe1234";
  const REPO_FULL = "acme/widget";
  const PR_NUMBER = 42;

  let commentCalls: Array<{ issue_number: number; body: string }> = [];
  let pullsGetCalls: Array<{ pull_number: number }> = [];
  let incSlashCommandSpy: ReturnType<typeof spyOn<typeof metricsModule, "incSlashCommand">>;
  let deleteSpy: ReturnType<typeof spyOn<typeof resultCache, "delete">>;

  function makeOctokit(): Octokit {
    return {
      issues: {
        createComment: async (args: { issue_number: number; body: string }) => {
          commentCalls.push(args);
        },
      },
      pulls: {
        get: async (args: { pull_number: number }) => {
          pullsGetCalls.push(args);
          return { data: { head: { sha: HEAD_SHA } } };
        },
        listReviews: async () => ({ data: [] }),
      },
      checks: {
        listForRef: async () => ({ data: { check_runs: [] } }),
      },
      repos: {
        listCommitStatusesForRef: async () => ({ data: [] }),
      },
      paginate: {
        // Return empty data so CI gate is not-green; triggerExplicit bails
        // before running the pipeline. We only need to verify the path was
        // entered (pulls.get was called), not that a full review ran.
        iterator: async function* (_fn: unknown, _params: unknown) {
          yield { data: [] };
        },
      },
    } as unknown as Octokit;
  }

  function makeWebhooks() {
    return createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: makeOctokit(),
      anthropic: {} as Anthropic,
      selfLogin: "review-me-bot",
    });
  }

  function makeCommentPayload(body: string, login = "alice") {
    return {
      action: "created",
      issue: {
        number: PR_NUMBER,
        pull_request: {
          url: `https://api.github.com/repos/${REPO_FULL}/pulls/${PR_NUMBER}`,
        },
      },
      comment: {
        id: 1,
        body,
        user: { login },
      },
      repository: {
        full_name: REPO_FULL,
        owner: { login: "acme" },
        name: "widget",
      },
      sender: { login },
      installation: { id: 1 },
    };
  }

  beforeEach(() => {
    commentCalls = [];
    pullsGetCalls = [];
    resultCache.clear();
    incSlashCommandSpy = spyOn(metricsModule, "incSlashCommand").mockImplementation(() => {});
    deleteSpy = spyOn(resultCache, "delete");
  });

  afterEach(() => {
    incSlashCommandSpy.mockRestore();
    deleteSpy.mockRestore();
    resultCache.clear();
  });

  test("metric bumped with command='refresh'", async () => {
    const wh = makeWebhooks();
    await fireEvent(wh, "issue_comment", makeCommentPayload("/review-me refresh"));

    const refreshCalls = incSlashCommandSpy.mock.calls.filter(
      (c) => c[0] === "refresh",
    );
    expect(refreshCalls.length).toBe(1);
  });

  test("pulls.get called to retrieve head SHA", async () => {
    const wh = makeWebhooks();
    await fireEvent(wh, "issue_comment", makeCommentPayload("/review-me refresh"));
    expect(pullsGetCalls.length).toBe(1);
    expect(pullsGetCalls[0]!.pull_number).toBe(PR_NUMBER);
  });

  test("resultCache.delete called with correct key after head SHA fetched", async () => {
    const wh = makeWebhooks();
    await fireEvent(wh, "issue_comment", makeCommentPayload("/review-me refresh"));

    const expectedKey = `${REPO_FULL}@${HEAD_SHA}`;
    expect(deleteSpy).toHaveBeenCalledWith(expectedKey);
  });

  test("ack comment posted before re-review is triggered", async () => {
    const wh = makeWebhooks();
    await fireEvent(wh, "issue_comment", makeCommentPayload("/review-me refresh"));

    expect(commentCalls.length).toBe(1);
    expect(commentCalls[0]!.body).toContain("Cache cleared");
    expect(commentCalls[0]!.body).toContain("fresh review");
    expect(commentCalls[0]!.issue_number).toBe(PR_NUMBER);
  });

  test("re-review path entered: triggerExplicit called (CI gate evaluated)", async () => {
    // triggerExplicit calls evaluateHeadSha which calls paginate.iterator.
    // We verify the path was entered by checking that pulls.get (needed to
    // get the head SHA) was called followed by the CI gate evaluation.
    let paginateCallCount = 0;
    const octokitWithSpy: Octokit = {
      issues: {
        createComment: async (args: { issue_number: number; body: string }) => {
          commentCalls.push(args);
        },
      },
      pulls: {
        get: async (args: { pull_number: number }) => {
          pullsGetCalls.push(args);
          return { data: { head: { sha: HEAD_SHA } } };
        },
        listReviews: async () => ({ data: [] }),
      },
      checks: {
        listForRef: async () => ({ data: { check_runs: [] } }),
      },
      repos: {
        listCommitStatusesForRef: async () => ({ data: [] }),
      },
      paginate: {
        iterator: async function* (_fn: unknown, _params: unknown) {
          paginateCallCount++;
          yield { data: [] };
        },
      },
    } as unknown as Octokit;

    const wh = createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: octokitWithSpy,
      anthropic: {} as Anthropic,
      selfLogin: "review-me-bot",
    });

    await fireEvent(wh, "issue_comment", makeCommentPayload("/review-me refresh"));

    // evaluateHeadSha calls paginate.iterator at least once inside triggerExplicit.
    expect(paginateCallCount).toBeGreaterThanOrEqual(1);
  });

  test("cache entry is actually evicted before pipeline runs", async () => {
    // Prime the cache with a stale result for the PR's head SHA.
    const cacheKey = `${REPO_FULL}@${HEAD_SHA}`;
    resultCache.set(cacheKey, makeOutput("stale result"));
    expect(resultCache.get(cacheKey)).toBeDefined();

    // Restore the real delete so we test the actual eviction.
    deleteSpy.mockRestore();

    const wh = makeWebhooks();
    await fireEvent(wh, "issue_comment", makeCommentPayload("/review-me refresh"));

    // The cached entry must be gone after the command was handled.
    expect(resultCache.get(cacheKey)).toBeUndefined();
  });

  test("bot's own ack comment is ignored (no webhook loop)", async () => {
    const wh = makeWebhooks();
    // Simulate the bot posting its own ack comment containing /review-me text.
    await fireEvent(
      wh,
      "issue_comment",
      makeCommentPayload(
        "Cache cleared for this head SHA — triggering fresh review…",
        "review-me-bot", // selfLogin
      ),
    );
    // Handler returns early for the bot's own comments.
    expect(commentCalls.length).toBe(0);
    expect(pullsGetCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// /review-me help includes refresh
// ---------------------------------------------------------------------------

describe("help command lists refresh", () => {
  let commentCalls: Array<{ issue_number: number; body: string }> = [];

  function makeOctokit(): Octokit {
    return {
      issues: {
        createComment: async (args: { issue_number: number; body: string }) => {
          commentCalls.push(args);
        },
      },
      pulls: {
        get: async () => ({ data: { head: { sha: "abc123" } } }),
        listReviews: async () => ({ data: [] }),
      },
      checks: { listForRef: async () => ({ data: { check_runs: [] } }) },
      repos: { listCommitStatusesForRef: async () => ({ data: [] }) },
      paginate: {
        iterator: async function* () {
          yield { data: [] };
        },
      },
    } as unknown as Octokit;
  }

  function makeCommentPayload(body: string) {
    return {
      action: "created",
      issue: {
        number: 1,
        pull_request: { url: "https://api.github.com/repos/acme/widget/pulls/1" },
      },
      comment: { id: 1, body, user: { login: "alice" } },
      repository: {
        full_name: "acme/widget",
        owner: { login: "acme" },
        name: "widget",
      },
      sender: { login: "alice" },
      installation: { id: 1 },
    };
  }

  beforeEach(() => {
    commentCalls = [];
  });

  test("/review-me help body lists /review-me refresh", async () => {
    const wh = createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: makeOctokit(),
      anthropic: {} as Anthropic,
      selfLogin: "review-me-bot",
    });

    await fireEvent(wh, "issue_comment", makeCommentPayload("/review-me help"));

    expect(commentCalls.length).toBe(1);
    const helpBody = commentCalls[0]!.body;
    expect(helpBody).toContain("/review-me refresh");
    expect(helpBody).toContain("fresh review");
  });

  test("help body still contains all existing commands (regression)", async () => {
    const wh = createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: makeOctokit(),
      anthropic: {} as Anthropic,
      selfLogin: "review-me-bot",
    });

    await fireEvent(wh, "issue_comment", makeCommentPayload("/review-me help"));

    const helpBody = commentCalls[0]!.body;
    expect(helpBody).toContain("/review-me skip");
    expect(helpBody).toContain("/review-me resume");
    expect(helpBody).toContain("/review-me re-review");
    expect(helpBody).toContain("/review-me help");
  });
});
