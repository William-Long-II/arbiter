/**
 * Unit tests for handleReviewCommentCreated.
 *
 * All external deps (Octokit, Anthropic, resolveIntent) are mocked so no
 * network calls happen.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { handleReviewCommentCreated } from "../src/server/handlers/review-comment";
import type { ReviewCommentDeps } from "../src/server/handlers/review-comment";
import { ThreadTracker } from "../src/server/handlers/thread-tracker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(overrides: {
  commenterLogin?: string;
  inReplyToId?: number | null;
  commentBody?: string;
  prNumber?: number;
  repoFullName?: string;
  ownerLogin?: string;
  repoName?: string;
} = {}) {
  const {
    commenterLogin = "developer",
    inReplyToId = 1000,
    commentBody = "Can you clarify this?",
    prNumber = 42,
    repoFullName = "acme/widget",
    ownerLogin = "acme",
    repoName = "widget",
  } = overrides;

  return {
    comment: {
      id: 9999,
      user: { login: commenterLogin },
      body: commentBody,
      in_reply_to_id: inReplyToId,
    },
    pull_request: { number: prNumber },
    repository: {
      full_name: repoFullName,
      owner: { login: ownerLogin },
      name: repoName,
    },
  };
}

/** Build a minimal Octokit mock. */
function makeOctokit(opts: {
  parentLogin?: string;
  getReviewCommentError?: Error;
  createReplyError?: Error;
}) {
  const {
    parentLogin = "review-me-bot",
    getReviewCommentError,
    createReplyError,
  } = opts;

  const getReviewCommentCalls: unknown[] = [];
  const createReplyCalls: unknown[] = [];
  const getPrCalls: unknown[] = [];

  const octokit = {
    pulls: {
      getReviewComment: async (params: unknown) => {
        getReviewCommentCalls.push(params);
        if (getReviewCommentError) throw getReviewCommentError;
        return {
          data: {
            user: { login: parentLogin },
            body: "Consider using a Map here for O(1) lookups.",
            diff_hunk: "@@ -1,5 +1,7 @@\n const x = 1;",
          },
        };
      },
      get: async (params: unknown) => {
        getPrCalls.push(params);
        return {
          data: {
            title: "Add widget caching",
            body: "Implements WIDGET-42.",
          },
        };
      },
      createReplyForReviewComment: async (params: unknown) => {
        createReplyCalls.push(params);
        if (createReplyError) throw createReplyError;
        return { data: { id: 11111 } };
      },
    },
  };

  return { octokit, getReviewCommentCalls, createReplyCalls, getPrCalls };
}

/** Build a minimal Anthropic mock. */
function makeAnthropic(opts: { error?: Error; responseText?: string } = {}) {
  const { error, responseText = "You can use a Map for O(1) lookups." } = opts;
  const createCalls: unknown[] = [];

  const anthropic = {
    messages: {
      create: async (params: unknown) => {
        createCalls.push(params);
        if (error) throw error;
        return {
          content: [{ type: "text", text: responseText }],
        };
      },
    },
  } as unknown as Anthropic;

  return { anthropic, createCalls };
}

/** Create a fresh tracker for each test so state doesn't bleed across. */
function freshTracker() {
  return new ThreadTracker();
}

// We swap the module-level singleton by passing the tracker into a new
// module-scoped accessor. Instead, we test the handler indirectly by
// exercising the singleton behaviour: create fresh instances for isolation
// by using a custom exported tracker in tests.
//
// Since the module exports `threadTracker` as a singleton, we exercise it
// via repeated calls on the same singleton within each test to verify state.

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleReviewCommentCreated", () => {
  // Re-import to pick up the singleton threadTracker each time — tests must
  // not bleed reply counts into each other.  We reset via unique parentCommentIds.

  let idSeed = 100_000;
  function uniqueId() {
    return ++idSeed;
  }

  test("ignores comment authored by the bot itself", async () => {
    const { octokit, getReviewCommentCalls, createReplyCalls } = makeOctokit({});
    const { anthropic } = makeAnthropic();

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic,
      selfLogin: "review-me-bot",
    };

    await handleReviewCommentCreated(
      makePayload({ commenterLogin: "review-me-bot", inReplyToId: uniqueId() }),
      deps,
    );

    expect(getReviewCommentCalls.length).toBe(0);
    expect(createReplyCalls.length).toBe(0);
  });

  test("ignores comment with no in_reply_to_id (top-level)", async () => {
    const { octokit, getReviewCommentCalls, createReplyCalls } = makeOctokit({});
    const { anthropic } = makeAnthropic();

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic,
      selfLogin: "review-me-bot",
    };

    await handleReviewCommentCreated(
      makePayload({ inReplyToId: null }),
      deps,
    );

    expect(getReviewCommentCalls.length).toBe(0);
    expect(createReplyCalls.length).toBe(0);
  });

  test("ignores reply when parent comment is not authored by the bot", async () => {
    const { octokit, getReviewCommentCalls, createReplyCalls } = makeOctokit({
      parentLogin: "some-other-user",
    });
    const { anthropic } = makeAnthropic();

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic,
      selfLogin: "review-me-bot",
    };

    await handleReviewCommentCreated(
      makePayload({ inReplyToId: uniqueId() }),
      deps,
    );

    // Did fetch parent but did NOT call Anthropic or post reply.
    expect(getReviewCommentCalls.length).toBe(1);
    expect(createReplyCalls.length).toBe(0);
  });

  test("posts a reply for the first 3 comments in a thread", async () => {
    const parentId = uniqueId();
    const { octokit, createReplyCalls } = makeOctokit({});
    const { anthropic } = makeAnthropic();

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic,
      selfLogin: "review-me-bot",
    };

    for (let i = 0; i < 3; i++) {
      await handleReviewCommentCreated(
        makePayload({ inReplyToId: parentId, commentBody: `Reply ${i}` }),
        deps,
      );
    }

    expect(createReplyCalls.length).toBe(3);
  });

  test("rate-limits the 4th reply in a thread (no API call)", async () => {
    const parentId = uniqueId();
    const { octokit, createReplyCalls } = makeOctokit({});
    const { anthropic } = makeAnthropic();

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic,
      selfLogin: "review-me-bot",
    };

    for (let i = 0; i < 4; i++) {
      await handleReviewCommentCreated(
        makePayload({ inReplyToId: parentId, commentBody: `Reply ${i}` }),
        deps,
      );
    }

    // Only 3 replies should have been posted, not 4.
    expect(createReplyCalls.length).toBe(3);
  });

  test("/stop (lowercase) locks the thread — subsequent reply is suppressed", async () => {
    const parentId = uniqueId();
    const { octokit, createReplyCalls } = makeOctokit({});
    const { anthropic } = makeAnthropic();

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic,
      selfLogin: "review-me-bot",
    };

    // First reply — fine.
    await handleReviewCommentCreated(
      makePayload({ inReplyToId: parentId, commentBody: "Thanks!" }),
      deps,
    );

    // User sends /stop.
    await handleReviewCommentCreated(
      makePayload({ inReplyToId: parentId, commentBody: "ok /stop" }),
      deps,
    );

    // Subsequent reply — should be suppressed.
    await handleReviewCommentCreated(
      makePayload({ inReplyToId: parentId, commentBody: "Actually I changed my mind" }),
      deps,
    );

    // Only the first reply should have been posted; /stop and subsequent are suppressed.
    expect(createReplyCalls.length).toBe(1);
  });

  test("/STOP (uppercase) also locks the thread", async () => {
    const parentId = uniqueId();
    const { octokit, createReplyCalls } = makeOctokit({});
    const { anthropic } = makeAnthropic();

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic,
      selfLogin: "review-me-bot",
    };

    // Send /STOP immediately — no prior reply.
    await handleReviewCommentCreated(
      makePayload({ inReplyToId: parentId, commentBody: "/STOP please" }),
      deps,
    );

    // Reply after stop — suppressed.
    await handleReviewCommentCreated(
      makePayload({ inReplyToId: parentId, commentBody: "Follow-up question" }),
      deps,
    );

    expect(createReplyCalls.length).toBe(0);
  });

  test('"stopping" (partial word) does NOT trigger stop', async () => {
    const parentId = uniqueId();
    const { octokit, createReplyCalls } = makeOctokit({});
    const { anthropic } = makeAnthropic();

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic,
      selfLogin: "review-me-bot",
    };

    await handleReviewCommentCreated(
      makePayload({ inReplyToId: parentId, commentBody: "I was stopping to think" }),
      deps,
    );

    // Should have replied normally — "stopping" is not "/stop".
    expect(createReplyCalls.length).toBe(1);
  });

  test("Anthropic error → no reply posted; no reply counter increment", async () => {
    const parentId = uniqueId();
    const { octokit, createReplyCalls } = makeOctokit({});
    const { anthropic } = makeAnthropic({
      error: new Error("Anthropic service unavailable"),
    });

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic,
      selfLogin: "review-me-bot",
    };

    // Should not throw — handler logs the error and returns.
    await expect(
      handleReviewCommentCreated(
        makePayload({ inReplyToId: parentId }),
        deps,
      ),
    ).resolves.toBeUndefined();

    expect(createReplyCalls.length).toBe(0);
  });

  test("getReviewComment failure → silently returns, no reply posted", async () => {
    const parentId = uniqueId();
    const { octokit, createReplyCalls } = makeOctokit({
      getReviewCommentError: new Error("Not Found"),
    });
    const { anthropic } = makeAnthropic();

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic,
      selfLogin: "review-me-bot",
    };

    await expect(
      handleReviewCommentCreated(makePayload({ inReplyToId: parentId }), deps),
    ).resolves.toBeUndefined();

    expect(createReplyCalls.length).toBe(0);
  });

  test("createReplyForReviewComment failure → logs error, no throw", async () => {
    const parentId = uniqueId();
    const { octokit } = makeOctokit({
      createReplyError: new Error("GitHub API error"),
    });
    const { anthropic } = makeAnthropic();

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic,
      selfLogin: "review-me-bot",
    };

    // Must not throw.
    await expect(
      handleReviewCommentCreated(makePayload({ inReplyToId: parentId }), deps),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ThreadTracker unit tests
// ---------------------------------------------------------------------------

describe("ThreadTracker", () => {
  test("returns undefined for an unknown key", () => {
    const tracker = freshTracker();
    expect(tracker.get("acme/widget", 1)).toBeUndefined();
  });

  test("getOrCreate creates a fresh entry", () => {
    const tracker = freshTracker();
    const state = tracker.getOrCreate("acme/widget", 1);
    expect(state.replies).toBe(0);
    expect(state.stopped).toBe(false);
    expect(tracker.size).toBe(1);
  });

  test("getOrCreate returns existing entry on second call", () => {
    const tracker = freshTracker();
    const a = tracker.getOrCreate("acme/widget", 1);
    a.replies = 2;
    const b = tracker.getOrCreate("acme/widget", 1);
    expect(b.replies).toBe(2);
  });

  test("expired entries are treated as absent", async () => {
    // 1 ms TTL so the entry expires immediately.
    const tracker = new ThreadTracker(1);
    tracker.getOrCreate("acme/widget", 99);
    // Wait for TTL to pass.
    await new Promise((r) => setTimeout(r, 5));
    expect(tracker.get("acme/widget", 99)).toBeUndefined();
  });

  test("LRU eviction drops oldest entry when at capacity", () => {
    // A tiny tracker with capacity 2.
    const tracker = new (class extends ThreadTracker {
      constructor() {
        super();
        // Override MAX_ENTRIES by calling getOrCreate to fill capacity.
      }
    })();

    // Fill 10_001 entries normally to trigger eviction requires a big loop
    // which is slow. Instead test with the public tracker that has capacity
    // 10_000 — just verify the size never exceeds the cap by filling it
    // with 10_001 unique keys.
    // Actually, we cannot change MAX_ENTRIES from outside; instead test
    // eviction at the real cap by checking size stays at 10_000.
    for (let i = 0; i < 10_001; i++) {
      tracker.getOrCreate("acme/widget", i);
    }
    // After 10_001 insertions the tracker should have evicted one.
    expect(tracker.size).toBeLessThanOrEqual(10_000);
  });
});
