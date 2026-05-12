import { octokitFor } from './api.ts';

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

/**
 * Post a PR review with a body. Defaults to COMMENT — neither approving
 * nor requesting changes. Posting as the OAuth'd user (their token), so
 * the review will be authored by them on the PR thread.
 */
export async function postPullRequestReview(
  token: string,
  repoFull: string,
  pullNumber: number,
  body: string,
  event: ReviewEvent = 'COMMENT',
): Promise<{ id: number; htmlUrl: string }> {
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFull: ${repoFull}`);
  const octokit = octokitFor(token);
  const res = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    body,
    event,
  });
  return { id: res.data.id, htmlUrl: res.data.html_url };
}

/**
 * GitHub's unified-diff endpoint refuses PRs with more than 300 files.
 * The error surfaces as 422 with `code: "too_large"`. Thrown by
 * fetchPullRequest so the worker can mark the row `skipped` (not failed)
 * — there's no point retrying a structural limit.
 */
export class DiffTooManyFilesError extends Error {
  constructor(public readonly repoFull: string, public readonly pullNumber: number) {
    super(
      `${repoFull}#${pullNumber} has too many changed files for GitHub's unified-diff endpoint (>300). ` +
        `Skipping automated review; this PR needs a human eye.`,
    );
    this.name = 'DiffTooManyFilesError';
  }
}

function isTooLargeDiffError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: unknown; response?: { data?: { errors?: unknown } } };
  if (e.status !== 422) return false;
  const errors = e.response?.data?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (x) => typeof x === 'object' && x !== null && (x as { code?: unknown }).code === 'too_large',
  );
}

export type PRDetails = {
  repoFull: string;
  number: number;
  title: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  draft: boolean;
  /** True if the PR is configured to auto-merge once checks pass. Poller
   * skips these — if the author has already opted into "merge when ready,"
   * a generated review is wasted effort. */
  autoMerge: boolean;
};

/**
 * Fetch a PR's metadata and unified diff. The diff is requested via GitHub's
 * `application/vnd.github.diff` media type — Octokit returns it as a raw
 * string in `.data`, not the JSON shape its types suggest.
 */
export async function fetchPullRequest(
  token: string,
  repoFull: string,
  pullNumber: number,
): Promise<{ pr: PRDetails; diff: string }> {
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFull: ${repoFull}`);

  const octokit = octokitFor(token);

  const meta = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  let diffResp;
  try {
    diffResp = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: { format: 'diff' },
    });
  } catch (err) {
    // 422 with code 'too_large' = PR has >300 files. Surface as a typed
    // error so the worker can skip cleanly instead of marking failed.
    if (isTooLargeDiffError(err)) {
      throw new DiffTooManyFilesError(repoFull, pullNumber);
    }
    throw err;
  }

  const m = meta.data;
  return {
    pr: {
      repoFull,
      number: pullNumber,
      title: m.title,
      author: m.user?.login ?? 'unknown',
      baseBranch: m.base.ref,
      headBranch: m.head.ref,
      headSha: m.head.sha,
      draft: m.draft ?? false,
      autoMerge: m.auto_merge !== null,
    },
    diff: diffResp.data as unknown as string,
  };
}

/**
 * List open PRs in a single repo. Used by the manual `/repos/owner/name/prs`
 * debugging page. Thin wrapper over listOpenPullsForScopes — same underlying
 * GraphQL search, single repo target — so all polling now flows through one
 * code path. Drafts are filtered by listOpenPullsForScopes.
 */
export async function listOpenPullsForRepo(
  token: string,
  repoFull: string,
): Promise<PRDetails[]> {
  const [owner, name] = repoFull.split('/');
  if (!owner || !name) throw new Error(`Invalid repoFull: ${repoFull}`);
  return listOpenPullsForScopes(
    token,
    [{ kind: 'repo', target: repoFull }],
    [],
  );
}

export type ScopeTarget = {
  kind: 'org' | 'repo';
  /** "owner" for org targets, "owner/name" for repo targets. */
  target: string;
};

/**
 * One open PR returned by the GraphQL search. Mirrors PRDetails plus a
 * `reviewRequestedForViewer` flag — derived from whether the PR was found
 * via the `review-requested:@me` half of the query (server-side, so it
 * accounts for team memberships).
 */
export type ScopedPR = PRDetails & {
  reviewRequestedForViewer: boolean;
};

type GraphQLSearchPR = {
  number: number;
  title: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  author: { login: string } | null;
  autoMergeRequest: { __typename: string } | null;
  repository: { nameWithOwner: string };
};

type GraphQLSearchResponse = {
  search: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<GraphQLSearchPR | null>;
  };
};

const SEARCH_QUERY = /* GraphQL */ `
  query($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          number
          title
          isDraft
          baseRefName
          headRefName
          headRefOid
          author { login }
          autoMergeRequest { __typename }
          repository { nameWithOwner }
        }
      }
    }
  }
`;

const MAX_SEARCH_PAGES = 10; // up to 1000 PRs per query — search caps at 1000

/**
 * Build the `q` string for GitHub's search syntax from a set of targets.
 * Always includes `is:pr is:open`. Extra terms appended as-is.
 */
function buildSearchQuery(targets: ScopeTarget[], extra: string[] = []): string {
  const terms = targets.map((t) =>
    t.kind === 'org' ? `org:${t.target}` : `repo:${t.target}`,
  );
  return ['is:pr', 'is:open', ...terms, ...extra].join(' ');
}

/**
 * Run a single GraphQL search query, paginated up to MAX_SEARCH_PAGES.
 * Returns the raw PullRequest nodes (drafts included; caller filters).
 */
async function runSearch(
  token: string,
  q: string,
): Promise<GraphQLSearchPR[]> {
  const octokit = octokitFor(token);
  const out: GraphQLSearchPR[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const resp: GraphQLSearchResponse = await octokit.graphql(SEARCH_QUERY, {
      q,
      after,
    });
    for (const node of resp.search.nodes) {
      if (node && node.repository) out.push(node);
    }
    if (!resp.search.pageInfo.hasNextPage || !resp.search.pageInfo.endCursor) break;
    after = resp.search.pageInfo.endCursor;
  }
  return out;
}

function toPRDetails(r: GraphQLSearchPR): PRDetails {
  return {
    repoFull: r.repository.nameWithOwner,
    number: r.number,
    title: r.title,
    author: r.author?.login ?? 'unknown',
    baseBranch: r.baseRefName,
    headBranch: r.headRefName,
    headSha: r.headRefOid,
    draft: r.isDraft,
    autoMerge: r.autoMergeRequest !== null,
  };
}

/**
 * List open PRs for the user's scopes in a single (or two) GraphQL queries.
 *
 * Two query batches:
 *  1. `is:pr is:open <targets>` — every open PR in any target.
 *  2. `is:pr is:open review-requested:@me <targets>` — only PRs where the
 *     viewer (or one of their teams) is in the requested-reviewers list.
 *     Run server-side so team memberships are resolved correctly.
 *
 * We always run (1) if any target has a scope in `open` trigger mode, and (2)
 * if any has `review_requested`. PRs returned by (2) are flagged with
 * `reviewRequestedForViewer = true`; the poller uses that flag to gate
 * scopes that opted into the tighter signal.
 *
 * One pass per batch instead of one REST call per target — a user with 50
 * scope targets goes from ~50 list calls to 1-2 GraphQL queries per tick.
 */
export async function listOpenPullsForScopes(
  token: string,
  openTargets: ScopeTarget[],
  reviewRequestedTargets: ScopeTarget[],
): Promise<ScopedPR[]> {
  if (openTargets.length === 0 && reviewRequestedTargets.length === 0) {
    return [];
  }

  const empty = Promise.resolve<GraphQLSearchPR[]>([]);
  const [openResults, reviewRequestedResults] = await Promise.all([
    openTargets.length > 0
      ? runSearch(token, buildSearchQuery(openTargets))
      : empty,
    reviewRequestedTargets.length > 0
      ? runSearch(
          token,
          buildSearchQuery(reviewRequestedTargets, ['review-requested:@me']),
        )
      : empty,
  ]);

  const merged = new Map<string, ScopedPR>();
  const ingest = (nodes: GraphQLSearchPR[], fromReviewRequested: boolean) => {
    for (const node of nodes) {
      if (node.isDraft) continue;
      const details = toPRDetails(node);
      const key = `${details.repoFull}#${details.number}`;
      const existing = merged.get(key);
      if (existing) {
        // Keep the requested flag sticky — once true, stays true.
        existing.reviewRequestedForViewer ||= fromReviewRequested;
      } else {
        merged.set(key, {
          ...details,
          reviewRequestedForViewer: fromReviewRequested,
        });
      }
    }
  };
  // Order matters only for clarity: ingest open first so the requested
  // batch flips the flag for any overlap.
  ingest(openResults, false);
  ingest(reviewRequestedResults, true);
  return [...merged.values()];
}

// Exported for the test file so it can assert query construction without
// hitting the network.
export const __internals = { buildSearchQuery };
