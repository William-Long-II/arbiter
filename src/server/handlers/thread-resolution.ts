/**
 * Thread resolution checker for pull_request_review_comment events.
 *
 * GitHub's REST API does not expose whether a review thread has been resolved
 * by a human — only the GraphQL API carries the `isResolved` flag on
 * `PullRequestReviewThread`. We use Octokit's bundled `graphql()` method to
 * query it with no additional dependencies.
 *
 * On any GraphQL failure we return `false` (fall through to reply) so that
 * transient API hiccups never silently block legitimate responses. The
 * failure is warn-logged so operators can see it in structured logs.
 *
 * Cache policy: resolution state is cached per (owner/name#pr:commentId) for
 * 5 minutes. A burst of replies within one conversation won't change
 * resolution state often, and a 5-minute stale window is an acceptable trade-
 * off against a synchronous GraphQL round-trip on every incoming comment.
 * The downside is that if a user resolves-then-unresolves within 5 minutes,
 * the bot will still skip the thread until the cache entry expires.
 */

import type { Octokit } from "../../github";
import { log } from "../logger";

// ---------------------------------------------------------------------------
// GraphQL query
// ---------------------------------------------------------------------------

/**
 * Fetch the first 50 review threads on a PR and check whether any of them
 * contains the given comment (by databaseId). Returns that thread's
 * `isResolved` flag.
 *
 * We limit to `first: 50` threads; on extremely chatty PRs the target thread
 * could fall beyond this window and the check would return `false` (safe
 * fallthrough). This is a conscious trade-off: a second page query adds
 * another round-trip and 50 threads is well above the P99 of real PRs.
 */
const REVIEW_THREAD_QUERY = `
  query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 50) {
          nodes {
            isResolved
            comments(first: 10) {
              nodes {
                databaseId
              }
            }
          }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes
const CACHE_MAX = 10_000;

type CacheEntry = {
  value: boolean;
  expiresAt: number;
};

// Map insertion order = access order for simple LRU.
const cache = new Map<string, CacheEntry>();

function cacheKey(
  owner: string,
  name: string,
  prNumber: number,
  commentId: number,
): string {
  return `${owner}/${name}#${prNumber}:${commentId}`;
}

function cacheGet(key: string): boolean | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  // Refresh LRU position.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(key: string, value: boolean): void {
  if (cache.size >= CACHE_MAX) {
    // Evict the least-recently-used (first inserted) entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ThreadResolutionParams = {
  octokit: Octokit;
  owner: string;
  name: string;
  prNumber: number;
  /** The `databaseId` of the comment whose thread we want to check. */
  commentId: number;
};

/**
 * Returns `true` when the review thread containing `commentId` has been
 * marked as Resolved by a human on GitHub.
 *
 * Returns `false` on any GraphQL error (fail-open: let the reply proceed).
 */
export async function isThreadResolved(
  params: ThreadResolutionParams,
): Promise<boolean> {
  const { octokit, owner, name, prNumber, commentId } = params;

  const key = cacheKey(owner, name, prNumber, commentId);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  type GraphQLResponse = {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: Array<{
            isResolved: boolean;
            comments?: {
              nodes?: Array<{ databaseId?: number }>;
            };
          }>;
        };
      };
    };
  };

  let result: boolean;
  try {
    const data = await octokit.graphql<GraphQLResponse>(REVIEW_THREAD_QUERY, {
      owner,
      name,
      pr: prNumber,
    });

    const threads =
      data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

    // Find the thread that contains the target comment by databaseId.
    const thread = threads.find((t) =>
      (t.comments?.nodes ?? []).some((c) => c.databaseId === commentId),
    );

    result = thread?.isResolved ?? false;
  } catch (err) {
    log.warn("thread: GraphQL resolution lookup failed, proceeding with reply", {
      evt: "thread.resolution_lookup_failed",
      owner,
      repo: name,
      pr: prNumber,
      commentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false; // fail-open: do not block the reply
  }

  cacheSet(key, result);
  return result;
}

/** Visible for testing — clears the resolution cache. */
export function clearResolutionCache(): void {
  cache.clear();
}

/** Visible for testing — returns current cache size. */
export function resolutionCacheSize(): number {
  return cache.size;
}
