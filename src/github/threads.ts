// PR review-thread hygiene. Each arbiter pass owns its inline threads; a
// new pass supersedes the old pass's findings (anything still wrong gets
// re-flagged at the current line). Left unresolved, those stale threads
// gate merges on repos with "require conversation resolution" — even when
// the new pass APPROVEs. Thread ids and the resolve mutation only exist
// in the GraphQL API, hence no octokit.rest here.

import { octokitFor } from './api.ts';

/** The slice of a PR review thread the resolve policy needs. */
export type PRReviewThread = {
  /** GraphQL node id — what resolveReviewThread takes. */
  id: string;
  isResolved: boolean;
  /** Author login of every comment in the thread, in order. `null` for
   *  comments whose author is unavailable (deleted account, some bots). */
  commentAuthors: Array<string | null>;
};

type ThreadsResponse = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          comments: { nodes: Array<{ author: { login: string } | null } | null> };
        } | null>;
      };
    } | null;
  } | null;
};

const THREADS_QUERY = /* GraphQL */ `
  query($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            comments(first: 50) {
              nodes { author { login } }
            }
          }
        }
      }
    }
  }
`;

const MAX_THREAD_PAGES = 5; // 500 threads; far beyond any sane PR

/** All review threads on a PR, paginated. */
export async function listReviewThreads(
  token: string,
  repoFull: string,
  pullNumber: number,
): Promise<PRReviewThread[]> {
  const [owner, name] = repoFull.split('/');
  if (!owner || !name) throw new Error(`Invalid repoFull: ${repoFull}`);
  const octokit = octokitFor(token);

  const out: PRReviewThread[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const resp: ThreadsResponse = await octokit.graphql(THREADS_QUERY, {
      owner,
      name,
      number: pullNumber,
      after,
    });
    const threads = resp.repository?.pullRequest?.reviewThreads;
    if (!threads) break;
    for (const node of threads.nodes) {
      if (!node) continue;
      out.push({
        id: node.id,
        isResolved: node.isResolved,
        commentAuthors: node.comments.nodes.map((c) =>
          c ? c.author?.login ?? null : null,
        ),
      });
    }
    if (!threads.pageInfo.hasNextPage || !threads.pageInfo.endCursor) break;
    after = threads.pageInfo.endCursor;
  }
  return out;
}

const RESOLVE_MUTATION = /* GraphQL */ `
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id }
    }
  }
`;

/** Mark one review thread resolved. Needs write access to the repo. */
export async function resolveReviewThread(
  token: string,
  threadId: string,
): Promise<void> {
  const octokit = octokitFor(token);
  await octokit.graphql(RESOLVE_MUTATION, { threadId });
}

/**
 * Which prior threads a new review pass may resolve. Pure — unit-tested.
 *
 * A thread qualifies only when it is unresolved AND every comment in it
 * was written by the reviewing account itself. One reply from anyone
 * else (or an unattributable comment) means a live conversation that is
 * not arbiter's to close — GitHub shows WHO resolved a thread, so being
 * conservative here is what keeps the feature trustworthy.
 */
export function selectThreadsToResolve(
  threads: PRReviewThread[],
  reviewerLogin: string,
): string[] {
  const me = reviewerLogin.toLowerCase();
  return threads
    .filter(
      (t) =>
        !t.isResolved &&
        t.commentAuthors.length > 0 &&
        t.commentAuthors.every((a) => a !== null && a.toLowerCase() === me),
    )
    .map((t) => t.id);
}
