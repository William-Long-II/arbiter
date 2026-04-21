/**
 * Auto-resolve stale bot review threads when a new review lands.
 *
 * When the bot posts a fresh review on a new head SHA, prior review threads
 * that were created by the bot on an older commit are no longer actionable.
 * Resolving them keeps the PR's "unresolved threads" count accurate and
 * reduces visual noise for reviewers.
 *
 * Design notes:
 * - Uses Octokit's bundled `graphql()` — no new dependencies.
 * - Rate-limited to MAX_RESOLUTIONS (50) per call to guard against chatty PRs
 *   hitting GraphQL mutation quota. Oldest threads (by position in the query
 *   response) are resolved first; the rest are skipped with a warn log.
 * - Per-thread mutation failures are logged and do not stop the remaining
 *   resolutions (fail-partial, not fail-fast).
 * - The function is called fire-and-forget from `postReview`; callers must
 *   `.catch()` the returned promise.
 *
 * Known limitation: if every resolve mutation fails, the returned
 * `{ resolved: 0, skipped: N }` is indistinguishable from "no candidates
 * found". Operators should watch for warn logs containing `evt:
 * 'thread.auto_resolve_mutation_failed'` to surface this condition. On PRs
 * with a very high thread count the 50-mutation cap can be hit repeatedly
 * across review cycles, leaving old threads unresolved indefinitely.
 */

import type { Octokit } from "./client";
import { log } from "../server/logger";
import { incThreadAutoResolved } from "../server/metrics";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of threads resolved per invocation. Guards API quota. */
const MAX_RESOLUTIONS = 50;

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes {
            id
            isResolved
            originalCommit {
              oid
            }
            comments(first: 1) {
              nodes {
                author {
                  login
                }
                databaseId
              }
            }
          }
        }
      }
    }
  }
`;

const RESOLVE_THREAD_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReviewThread = {
  id: string;
  isResolved: boolean;
  originalCommit: { oid: string } | null;
  comments: {
    nodes: Array<{
      author: { login: string } | null;
      databaseId: number | null;
    }>;
  };
};

type ReviewThreadsResponse = {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        nodes?: ReviewThread[];
      };
    };
  };
};

export type ResolveBotThreadsParams = {
  octokit: Octokit;
  owner: string;
  name: string;
  prNumber: number;
  /** The bot's own GitHub login (e.g. `"review-me[bot]"`). */
  selfLogin: string;
  /** The head SHA of the review that was just posted. Threads on this SHA are kept open. */
  currentHeadSha: string;
};

export type ResolveBotThreadsResult = {
  resolved: number;
  skipped: number;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Query all review threads on the PR, then resolve any that are:
 *   1. Not yet resolved (`isResolved === false`)
 *   2. Authored by `selfLogin` (first comment on the thread)
 *   3. On a commit other than `currentHeadSha`
 *
 * At most MAX_RESOLUTIONS (50) threads are resolved per call. If there are
 * more candidates, the excess is skipped and a warning is logged.
 *
 * Returns `{ resolved, skipped }` counts. Individual mutation failures
 * are warn-logged and counted in `skipped`; they do not throw.
 */
export async function resolveBotThreadsForPR(
  params: ResolveBotThreadsParams,
): Promise<ResolveBotThreadsResult> {
  const { octokit, owner, name, prNumber, selfLogin, currentHeadSha } = params;

  // --- Step 1: fetch all review threads ---
  const data = await octokit.graphql<ReviewThreadsResponse>(
    REVIEW_THREADS_QUERY,
    { owner, name, pr: prNumber },
  );

  const threads =
    data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

  // --- Step 2: filter to candidates ---
  const candidates = threads.filter((t) => {
    if (t.isResolved) return false;

    const firstComment = t.comments.nodes[0];
    if (!firstComment) return false;

    const authorLogin = firstComment.author?.login ?? "";
    if (authorLogin !== selfLogin) return false;

    const commitOid = t.originalCommit?.oid ?? "";
    if (commitOid === currentHeadSha) return false;

    return true;
  });

  let skipped = 0;

  // --- Step 3: enforce rate-limit cap ---
  let toResolve = candidates;
  if (candidates.length > MAX_RESOLUTIONS) {
    log.warn("thread: candidate thread count exceeds cap, truncating", {
      evt: "thread.auto_resolve_cap_exceeded",
      repo: `${owner}/${name}`,
      pr: prNumber,
      candidates: candidates.length,
      cap: MAX_RESOLUTIONS,
    });
    toResolve = candidates.slice(0, MAX_RESOLUTIONS);
    skipped += candidates.length - MAX_RESOLUTIONS;
  }

  if (toResolve.length === 0) {
    return { resolved: 0, skipped };
  }

  // --- Step 4: resolve each candidate thread ---
  let resolved = 0;

  for (const thread of toResolve) {
    try {
      await octokit.graphql(RESOLVE_THREAD_MUTATION, { threadId: thread.id });

      log.info("thread: auto-resolved stale bot thread", {
        evt: "thread.auto_resolved",
        repo: `${owner}/${name}`,
        pr: prNumber,
        thread_id: thread.id,
        reason: "stale_head_sha",
      });
      resolved += 1;
    } catch (err) {
      log.warn("thread: failed to auto-resolve thread, continuing", {
        evt: "thread.auto_resolve_mutation_failed",
        repo: `${owner}/${name}`,
        pr: prNumber,
        thread_id: thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
      skipped += 1;
    }
  }

  if (resolved > 0) {
    incThreadAutoResolved(resolved);
  }

  return { resolved, skipped };
}
