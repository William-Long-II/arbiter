/**
 * Unit tests for isThreadResolved and the resolution-skip integration
 * in handleReviewCommentCreated.
 *
 * All external deps (Octokit GraphQL, REST) are mocked. No network calls.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  isThreadResolved,
  clearResolutionCache,
  resolutionCacheSize,
} from "../src/server/handlers/thread-resolution";
import { handleReviewCommentCreated } from "../src/server/handlers/review-comment";
import type { ReviewCommentDeps } from "../src/server/handlers/review-comment";
import type Anthropic from "@anthropic-ai/sdk";
import { registry } from "../src/server/metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a GraphQL response with a single thread containing the given
 *  commentId, with configurable isResolved. */
function makeGraphQLResponse(commentId: number, isResolved: boolean) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [
            {
              isResolved,
              comments: {
                nodes: [{ databaseId: commentId }],
              },
            },
          ],
        },
      },
    },
  };
}

/** Build a minimal Octokit mock that supports both REST and GraphQL. */
function makeOctokit(opts: {
  parentLogin?: string;
  graphqlResponse?: unknown;
  graphqlError?: Error;
  createReplyError?: Error;
  getReviewCommentError?: Error;
}) {
  const {
    parentLogin = "review-me-bot",
    graphqlResponse,
    graphqlError,
    createReplyError,
    getReviewCommentError,
  } = opts;

  const graphqlCalls: unknown[] = [];
  const createReplyCalls: unknown[] = [];

  const octokit = {
    graphql: async <T>(query: string, variables: unknown): Promise<T> => {
      graphqlCalls.push({ query, variables });
      if (graphqlError) throw graphqlError;
      return graphqlResponse as T;
    },
    pulls: {
      getReviewComment: async (_params: unknown) => {
        if (getReviewCommentError) throw getReviewCommentError;
        return {
          data: {
            user: { login: parentLogin },
            body: "Use a Map here.",
            diff_hunk: "@@ -1,5 +1,7 @@\n const x = 1;",
          },
        };
      },
      get: async (_params: unknown) => ({
        data: {
          title: "Add caching",
          body: "No ticket.",
          draft: false,
        },
      }),
      createReplyForReviewComment: async (params: unknown) => {
        createReplyCalls.push(params);
        if (createReplyError) throw createReplyError;
        return { data: { id: 1 } };
      },
    },
  };

  return { octokit, graphqlCalls, createReplyCalls };
}

function makeAnthropic(): Anthropic {
  return {
    messages: {
      create: async (_params: unknown) => ({
        content: [{ type: "text", text: "Here is my reply." }],
      }),
    },
  } as unknown as Anthropic;
}

function makePayload(commentId: number, replyId: number) {
  return {
    comment: {
      id: replyId,
      user: { login: "developer" },
      body: "What do you think?",
      in_reply_to_id: commentId,
    },
    pull_request: { number: 42 },
    repository: {
      full_name: "acme/widget",
      owner: { login: "acme" },
      name: "widget",
    },
  };
}

// ---------------------------------------------------------------------------
// isThreadResolved unit tests
// ---------------------------------------------------------------------------

describe("isThreadResolved", () => {
  beforeEach(() => {
    clearResolutionCache();
  });

  test("returns true when the thread containing the comment is resolved", async () => {
    const commentId = 5001;
    const { octokit } = makeOctokit({
      graphqlResponse: makeGraphQLResponse(commentId, true),
    });

    const result = await isThreadResolved({
      octokit: octokit as unknown as Parameters<typeof isThreadResolved>[0]["octokit"],
      owner: "acme",
      name: "widget",
      prNumber: 42,
      commentId,
    });

    expect(result).toBe(true);
  });

  test("returns false when the thread containing the comment is not resolved", async () => {
    const commentId = 5002;
    const { octokit } = makeOctokit({
      graphqlResponse: makeGraphQLResponse(commentId, false),
    });

    const result = await isThreadResolved({
      octokit: octokit as unknown as Parameters<typeof isThreadResolved>[0]["octokit"],
      owner: "acme",
      name: "widget",
      prNumber: 42,
      commentId,
    });

    expect(result).toBe(false);
  });

  test("returns false (fail-open) when GraphQL throws", async () => {
    const commentId = 5003;
    const { octokit } = makeOctokit({
      graphqlError: new Error("GraphQL 502 Bad Gateway"),
    });

    const result = await isThreadResolved({
      octokit: octokit as unknown as Parameters<typeof isThreadResolved>[0]["octokit"],
      owner: "acme",
      name: "widget",
      prNumber: 42,
      commentId,
    });

    expect(result).toBe(false);
  });

  test("returns false when commentId is not found in any thread", async () => {
    const commentId = 5004;
    const { octokit } = makeOctokit({
      // The response contains a different commentId — target is missing.
      graphqlResponse: makeGraphQLResponse(9999, true),
    });

    const result = await isThreadResolved({
      octokit: octokit as unknown as Parameters<typeof isThreadResolved>[0]["octokit"],
      owner: "acme",
      name: "widget",
      prNumber: 42,
      commentId,
    });

    // Thread not found → default false (safe fallthrough).
    expect(result).toBe(false);
  });

  test("cache: two calls with same key within 5 min → single GraphQL call", async () => {
    const commentId = 5005;
    const { octokit, graphqlCalls } = makeOctokit({
      graphqlResponse: makeGraphQLResponse(commentId, true),
    });

    const params = {
      octokit: octokit as unknown as Parameters<typeof isThreadResolved>[0]["octokit"],
      owner: "acme",
      name: "widget",
      prNumber: 42,
      commentId,
    };

    const r1 = await isThreadResolved(params);
    const r2 = await isThreadResolved(params);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    // Only one GraphQL call was made; the second hit the cache.
    expect(graphqlCalls.length).toBe(1);
  });

  test("cache: different comment IDs are cached independently", async () => {
    const id1 = 6001;
    const id2 = 6002;
    const { octokit: o1, graphqlCalls: calls1 } = makeOctokit({
      graphqlResponse: makeGraphQLResponse(id1, true),
    });
    const { octokit: o2, graphqlCalls: calls2 } = makeOctokit({
      graphqlResponse: makeGraphQLResponse(id2, false),
    });

    const base = {
      owner: "acme",
      name: "widget",
      prNumber: 42,
    };

    const r1 = await isThreadResolved({
      ...base,
      octokit: o1 as unknown as Parameters<typeof isThreadResolved>[0]["octokit"],
      commentId: id1,
    });
    const r2 = await isThreadResolved({
      ...base,
      octokit: o2 as unknown as Parameters<typeof isThreadResolved>[0]["octokit"],
      commentId: id2,
    });

    expect(r1).toBe(true);
    expect(r2).toBe(false);
    expect(calls1.length).toBe(1);
    expect(calls2.length).toBe(1);
    expect(resolutionCacheSize()).toBe(2);
  });

  test("cache: GraphQL failure is NOT cached — next call retries", async () => {
    const commentId = 7001;
    const errOctokit = makeOctokit({
      graphqlError: new Error("transient error"),
    });
    const okOctokit = makeOctokit({
      graphqlResponse: makeGraphQLResponse(commentId, false),
    });

    // First call — GraphQL error, should return false.
    await isThreadResolved({
      octokit: errOctokit.octokit as unknown as Parameters<typeof isThreadResolved>[0]["octokit"],
      owner: "acme",
      name: "widget",
      prNumber: 42,
      commentId,
    });

    // Second call — no error now; should hit GraphQL again (not cache).
    const result = await isThreadResolved({
      octokit: okOctokit.octokit as unknown as Parameters<typeof isThreadResolved>[0]["octokit"],
      owner: "acme",
      name: "widget",
      prNumber: 42,
      commentId,
    });

    expect(result).toBe(false);
    // The second Octokit was called — confirming error result was not cached.
    expect(okOctokit.graphqlCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: handleReviewCommentCreated + thread resolution
// ---------------------------------------------------------------------------

describe("handleReviewCommentCreated — resolved thread skip", () => {
  let idSeed = 200_000;
  function uid() { return ++idSeed; }

  beforeEach(() => {
    clearResolutionCache();
  });

  test("resolved thread → no createReplyForReviewComment call, metric bumped", async () => {
    const commentId = uid();
    const { octokit, createReplyCalls } = makeOctokit({
      graphqlResponse: makeGraphQLResponse(commentId, true),
    });

    // Snapshot counter before.
    const before = getResolvedSkipCount();

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic: makeAnthropic(),
      selfLogin: "review-me-bot",
    };

    await handleReviewCommentCreated(makePayload(commentId, uid()), deps);

    expect(createReplyCalls.length).toBe(0);
    expect(getResolvedSkipCount()).toBe(before + 1);
  });

  test("unresolved thread → reply proceeds normally", async () => {
    const commentId = uid();
    const { octokit, createReplyCalls } = makeOctokit({
      graphqlResponse: makeGraphQLResponse(commentId, false),
    });

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic: makeAnthropic(),
      selfLogin: "review-me-bot",
    };

    await handleReviewCommentCreated(makePayload(commentId, uid()), deps);

    expect(createReplyCalls.length).toBe(1);
  });

  test("GraphQL failure → reply proceeds (fail-open)", async () => {
    const commentId = uid();
    const { octokit, createReplyCalls } = makeOctokit({
      graphqlError: new Error("GraphQL service unavailable"),
    });

    const deps: ReviewCommentDeps = {
      octokit: octokit as unknown as ReviewCommentDeps["octokit"],
      anthropic: makeAnthropic(),
      selfLogin: "review-me-bot",
    };

    await handleReviewCommentCreated(makePayload(commentId, uid()), deps);

    // Fall-open: reply should still go out.
    expect(createReplyCalls.length).toBe(1);
  });

  test("resolved skip does NOT count against the 3-reply cap", async () => {
    const commentId = uid();

    // First two events: thread is NOT resolved → replies go out.
    const { octokit: o1, createReplyCalls: c1 } = makeOctokit({
      graphqlResponse: makeGraphQLResponse(commentId, false),
    });
    for (let i = 0; i < 2; i++) {
      await handleReviewCommentCreated(makePayload(commentId, uid()), {
        octokit: o1 as unknown as ReviewCommentDeps["octokit"],
        anthropic: makeAnthropic(),
        selfLogin: "review-me-bot",
      });
    }
    expect(c1.length).toBe(2);

    clearResolutionCache();

    // Next event: thread is now resolved — skip, no reply, no counter bump.
    const { octokit: o2, createReplyCalls: c2 } = makeOctokit({
      graphqlResponse: makeGraphQLResponse(commentId, true),
    });
    await handleReviewCommentCreated(makePayload(commentId, uid()), {
      octokit: o2 as unknown as ReviewCommentDeps["octokit"],
      anthropic: makeAnthropic(),
      selfLogin: "review-me-bot",
    });
    expect(c2.length).toBe(0);

    clearResolutionCache();

    // Thread unresolves: should still be able to post (cap was 2, not 3).
    const { octokit: o3, createReplyCalls: c3 } = makeOctokit({
      graphqlResponse: makeGraphQLResponse(commentId, false),
    });
    await handleReviewCommentCreated(makePayload(commentId, uid()), {
      octokit: o3 as unknown as ReviewCommentDeps["octokit"],
      anthropic: makeAnthropic(),
      selfLogin: "review-me-bot",
    });
    expect(c3.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers for reading metric counters
// ---------------------------------------------------------------------------

function getResolvedSkipCount(): number {
  // Access the internal counter series via the rendered output.
  const text = registry.render();
  const match = text.match(/reviewme_thread_resolved_skip_total\s+(\d+)/);
  return match ? Number(match[1]) : 0;
}
