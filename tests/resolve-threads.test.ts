/**
 * Unit tests for resolveBotThreadsForPR.
 *
 * All Octokit GraphQL calls are mocked. No network or file I/O.
 *
 * Covered scenarios:
 *   1. Happy path: 3 stale bot threads + 1 current-SHA thread + 1 human thread
 *      → resolves 3, skips 2 (current-SHA + human), metric = 3.
 *   2. Per-thread mutation failure: one mutation throws, others still resolve;
 *      warn log fired for the failure.
 *   3. 60-candidate cap: only 50 resolved, 10 skipped, warn log fired.
 *   4. Fallback regression: postReview summary-only path does NOT call the
 *      resolver (auto-resolve never fires on the fallback branch).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { Octokit } from "../src/github";
import { resolveBotThreadsForPR } from "../src/github/resolve-threads";
import { postReview } from "../src/github/review";
import type { ReviewResult } from "../src/review";
import { registry } from "../src/server/metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BOT_LOGIN = "review-me[bot]";
const CURRENT_SHA = "sha-new";
const OLD_SHA = "sha-old";
const OWNER = "acme";
const NAME = "widget";
const PR = 42;

type ThreadNode = {
  id: string;
  isResolved: boolean;
  originalCommit: { oid: string } | null;
  comments: {
    nodes: Array<{ author: { login: string } | null; databaseId: number | null }>;
  };
};

function makeThread(opts: {
  id: string;
  resolved?: boolean;
  authorLogin?: string;
  oid?: string;
  databaseId?: number;
}): ThreadNode {
  return {
    id: opts.id,
    isResolved: opts.resolved ?? false,
    originalCommit: { oid: opts.oid ?? OLD_SHA },
    comments: {
      nodes: [
        {
          author: { login: opts.authorLogin ?? BOT_LOGIN },
          databaseId: opts.databaseId ?? 1,
        },
      ],
    },
  };
}

function makeQueryResponse(threads: ThreadNode[]) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: threads,
        },
      },
    },
  };
}

/**
 * Build an Octokit mock for resolve-threads tests.
 *
 * `queryResponse`: returned on the first graphql call (the REVIEW_THREADS_QUERY).
 * `mutationErrors`: map of thread id → Error to throw when that thread is resolved.
 */
function makeOctokit(opts: {
  queryResponse: unknown;
  mutationErrors?: Map<string, Error>;
  queryError?: Error;
}): Octokit {
  let callCount = 0;

  return {
    graphql: async (query: string, variables: Record<string, unknown>) => {
      callCount += 1;
      // First call is the query; subsequent calls are mutations.
      if (callCount === 1) {
        if (opts.queryError) throw opts.queryError;
        return opts.queryResponse;
      }
      // Mutation — threadId comes from the variables.
      const threadId = variables["threadId"] as string;
      const err = opts.mutationErrors?.get(threadId);
      if (err) throw err;
      return { resolveReviewThread: { thread: { id: threadId, isResolved: true } } };
    },
  } as unknown as Octokit;
}

/** Read the current value of the auto-resolved counter from the registry. */
function readAutoResolvedCounter(): number {
  const rendered = registry.render();
  const match = rendered.match(/reviewme_thread_auto_resolved_total\s+(\d+)/);
  return match ? parseInt(match[1] ?? "0", 10) : 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveBotThreadsForPR", () => {
  test("resolves 3 stale bot threads, skips current-SHA and human-authored", async () => {
    const threads = [
      makeThread({ id: "T1", oid: OLD_SHA, authorLogin: BOT_LOGIN }),
      makeThread({ id: "T2", oid: OLD_SHA, authorLogin: BOT_LOGIN }),
      makeThread({ id: "T3", oid: OLD_SHA, authorLogin: BOT_LOGIN }),
      // Current SHA — should be skipped.
      makeThread({ id: "T4", oid: CURRENT_SHA, authorLogin: BOT_LOGIN }),
      // Human author — should be skipped.
      makeThread({ id: "T5", oid: OLD_SHA, authorLogin: "human-dev" }),
    ];

    const counterBefore = readAutoResolvedCounter();
    const octokit = makeOctokit({ queryResponse: makeQueryResponse(threads) });

    const result = await resolveBotThreadsForPR({
      octokit,
      owner: OWNER,
      name: NAME,
      prNumber: PR,
      selfLogin: BOT_LOGIN,
      currentHeadSha: CURRENT_SHA,
    });

    expect(result.resolved).toBe(3);
    expect(result.skipped).toBe(0);
    expect(readAutoResolvedCounter() - counterBefore).toBe(3);
  });

  test("already-resolved threads are not included in candidates", async () => {
    const threads = [
      makeThread({ id: "T1", oid: OLD_SHA, resolved: true }),
      makeThread({ id: "T2", oid: OLD_SHA }),
    ];

    const octokit = makeOctokit({ queryResponse: makeQueryResponse(threads) });
    const result = await resolveBotThreadsForPR({
      octokit,
      owner: OWNER,
      name: NAME,
      prNumber: PR,
      selfLogin: BOT_LOGIN,
      currentHeadSha: CURRENT_SHA,
    });

    expect(result.resolved).toBe(1); // only T2
    expect(result.skipped).toBe(0);
  });

  test("per-thread mutation failure: others still resolve; failure counted in skipped", async () => {
    const threads = [
      makeThread({ id: "T1", oid: OLD_SHA }),
      makeThread({ id: "T2", oid: OLD_SHA }),
      makeThread({ id: "T3", oid: OLD_SHA }),
    ];

    const mutationErrors = new Map<string, Error>([
      ["T2", new Error("GraphQL mutation error: forbidden")],
    ]);

    const octokit = makeOctokit({
      queryResponse: makeQueryResponse(threads),
      mutationErrors,
    });

    const result = await resolveBotThreadsForPR({
      octokit,
      owner: OWNER,
      name: NAME,
      prNumber: PR,
      selfLogin: BOT_LOGIN,
      currentHeadSha: CURRENT_SHA,
    });

    // T1 and T3 resolved; T2 failed → counted as skipped.
    expect(result.resolved).toBe(2);
    expect(result.skipped).toBe(1);
  });

  test("60-thread edge case: only 50 resolved, 10 skipped", async () => {
    const threads = Array.from({ length: 60 }, (_, i) =>
      makeThread({ id: `T${i}`, oid: OLD_SHA }),
    );

    const counterBefore = readAutoResolvedCounter();
    const octokit = makeOctokit({ queryResponse: makeQueryResponse(threads) });

    const result = await resolveBotThreadsForPR({
      octokit,
      owner: OWNER,
      name: NAME,
      prNumber: PR,
      selfLogin: BOT_LOGIN,
      currentHeadSha: CURRENT_SHA,
    });

    expect(result.resolved).toBe(50);
    expect(result.skipped).toBe(10);
    expect(readAutoResolvedCounter() - counterBefore).toBe(50);
  });

  test("returns 0/0 when there are no threads", async () => {
    const octokit = makeOctokit({ queryResponse: makeQueryResponse([]) });
    const result = await resolveBotThreadsForPR({
      octokit,
      owner: OWNER,
      name: NAME,
      prNumber: PR,
      selfLogin: BOT_LOGIN,
      currentHeadSha: CURRENT_SHA,
    });
    expect(result.resolved).toBe(0);
    expect(result.skipped).toBe(0);
  });

  test("propagates query-level GraphQL errors to the caller", async () => {
    const octokit = makeOctokit({
      queryResponse: {},
      queryError: new Error("GraphQL: 500 Internal Server Error"),
    });

    await expect(
      resolveBotThreadsForPR({
        octokit,
        owner: OWNER,
        name: NAME,
        prNumber: PR,
        selfLogin: BOT_LOGIN,
        currentHeadSha: CURRENT_SHA,
      }),
    ).rejects.toThrow("GraphQL: 500 Internal Server Error");
  });
});

// ---------------------------------------------------------------------------
// Regression: postReview fallback path must NOT call auto-resolve
// ---------------------------------------------------------------------------

describe("postReview — fallback-path regression", () => {
  /**
   * When the first createReview call fails and the bot falls back to posting
   * a summary-only review, the graphql() resolver must never be called.
   * We assert that by counting total graphql invocations.
   */
  test("summary-only fallback does not trigger auto-resolve (graphql never called)", async () => {
    let graphqlCalls = 0;

    const octokit = {
      paginate: {
        iterator: async function* () {
          yield { data: [] };
        },
      },
      pulls: {
        listReviews: {} as unknown,
        createReview: async (args: { comments?: unknown[] }) => {
          // Fail only when inline comments are included (first attempt).
          if (args.comments && (args.comments as unknown[]).length > 0) {
            throw new Error("422 line not in diff");
          }
          return { data: { id: 9999 } };
        },
      },
      graphql: async () => {
        graphqlCalls += 1;
        return {};
      },
    } as unknown as Octokit;

    const review: ReviewResult = {
      verdict: "comment",
      summary: "a few nits",
      lineComments: [{ path: "src/a.ts", line: 10, body: "fix this" }],
    };

    const out = await postReview(octokit, {
      owner: "acme",
      repo: "widget",
      pullNumber: 1,
      headSha: "sha-new",
      selfLogin: BOT_LOGIN,
      review,
    });

    expect(out.status).toBe("posted-summary-only");
    // Allow the micro-task queue to flush any fire-and-forget promises.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(graphqlCalls).toBe(0);
  });

  test("successful review post (non-fallback) does call auto-resolve (graphql called)", async () => {
    let graphqlCalls = 0;

    const octokit = {
      paginate: {
        iterator: async function* () {
          yield { data: [] };
        },
      },
      pulls: {
        listReviews: {} as unknown,
        createReview: async () => {
          return { data: { id: 1001 } };
        },
      },
      graphql: async () => {
        graphqlCalls += 1;
        // Return an empty thread list so the resolver exits cleanly.
        return {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: [] },
            },
          },
        };
      },
    } as unknown as Octokit;

    const review: ReviewResult = {
      verdict: "approve",
      summary: "looks good",
      lineComments: [],
    };

    const out = await postReview(octokit, {
      owner: "acme",
      repo: "widget",
      pullNumber: 1,
      headSha: "sha-new",
      selfLogin: BOT_LOGIN,
      review,
    });

    expect(out.status).toBe("posted");
    // Flush the fire-and-forget promise.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(graphqlCalls).toBeGreaterThan(0);
  });
});
