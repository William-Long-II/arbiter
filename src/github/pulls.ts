import { octokitFor } from './api.ts';
import type { ReviewComment } from '../review/diffmap.ts';

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

/**
 * Post a PR review. Defaults to COMMENT — neither approving nor requesting
 * changes. Posting as the OAuth'd user (their token).
 *
 * `comments` (optional) attaches inline review comments. They're already
 * diff-validated by diffmap, but GitHub still rejects the WHOLE review if
 * any anchor is off — so if a call carrying comments fails for any reason,
 * we retry once body-only. An inline-mapping miss must never cost the
 * review itself; the findings are also in the summary body.
 */
export async function postPullRequestReview(
  token: string,
  repoFull: string,
  pullNumber: number,
  body: string,
  event: ReviewEvent = 'COMMENT',
  comments: ReviewComment[] = [],
): Promise<{ id: number; htmlUrl: string }> {
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFull: ${repoFull}`);
  const octokit = octokitFor(token);

  if (comments.length > 0) {
    try {
      const res = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        body,
        event,
        comments: comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body,
        })),
      });
      return { id: res.data.id, htmlUrl: res.data.html_url };
    } catch (err) {
      console.error(
        `[pulls] createReview with ${comments.length} inline comment(s) ` +
          `failed for ${repoFull}#${pullNumber}; retrying body-only: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      // fall through to the plain post
    }
  }

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
 * GitHub rejects posting a review when the PR conversation is locked:
 * HTTP 422 with "lock prevents review" in the body (the detail arrives as
 * a quoted string in `errors`, not the usual {code} object). The review
 * itself is already generated and valid — only the POST failed — so the
 * worker skips (not fails) and preserves the body for a later
 * "Post anyway", instead of a retry that would just re-lock.
 */
export function isLockedConversationError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    status?: unknown;
    message?: unknown;
    response?: { data?: unknown };
  };
  if (e.status !== 422) return false;

  const parts: string[] = [];
  if (typeof e.message === 'string') parts.push(e.message);
  const data = e.response?.data;
  if (typeof data === 'string') {
    parts.push(data);
  } else if (data && typeof data === 'object') {
    const d = data as { message?: unknown; errors?: unknown };
    if (typeof d.message === 'string') parts.push(d.message);
    if (Array.isArray(d.errors)) {
      for (const x of d.errors) {
        parts.push(typeof x === 'string' ? x : JSON.stringify(x));
      }
    }
  }
  return /lock prevents review/i.test(parts.join(' '));
}

/**
 * GitHub's unified-diff endpoint refuses PRs over its structural limits
 * (>300 changed files, or >20000 diff lines). It signals this with
 * `code: "too_large"` in the error payload — NOT with HTTP 422 (an earlier
 * version assumed 422 and so never matched; the diff media type returns
 * 406). Thrown by fetchPullRequest so the worker can mark the row
 * `skipped` (not failed) — there's no point retrying a structural limit.
 */
export class DiffTooManyFilesError extends Error {
  constructor(public readonly repoFull: string, public readonly pullNumber: number) {
    super(
      `${repoFull}#${pullNumber} is over GitHub's diff size limit (>300 files or >20000 lines). ` +
        `Skipping automated review; this PR needs a human eye.`,
    );
    this.name = 'DiffTooManyFilesError';
  }
}

/**
 * Detect GitHub's "diff too large" rejection. We key off the
 * `code: "too_large"` marker, which GitHub uses *only* for diff/content
 * size limits, so it's safe regardless of HTTP status (it's 406 for the
 * `.diff` media type, not 422 as previously assumed — that wrong
 * assumption meant every real occurrence fell through to `failed`).
 *
 * Defensive on shape: `response.data` may be a parsed object *or* a raw
 * string depending on the response content-type, and `errors` may be an
 * array or a single object — so we check the structured payload and fall
 * back to the human-readable message text.
 */
export function isTooLargeDiffError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { message?: unknown; response?: { data?: unknown } };

  const data = e.response?.data;
  if (data && typeof data === 'object') {
    const raw = (data as { errors?: unknown }).errors;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (
      list.some(
        (x) =>
          typeof x === 'object' &&
          x !== null &&
          (x as { code?: unknown }).code === 'too_large',
      )
    ) {
      return true;
    }
  }

  const haystack = `${typeof e.message === 'string' ? e.message : ''} ${
    typeof data === 'string' ? data : ''
  }`;
  return /exceeded the maximum number of (files|lines)/i.test(haystack);
}

/**
 * GitHub sometimes cannot generate the single-blob diff at all: the
 * request times out server-side and comes back as the "Unicorn!" HTML
 * error page with a 5xx status (surfaces as `HttpError: <!DOCTYPE html>…`).
 * The JSON endpoints for the same PR still work fine — only the diff
 * render is too expensive — so this is worth the listFiles fallback, not
 * a doomed retry of the identical request. A genuinely global GitHub 5xx
 * just fails the fallback call too, which stays transient/retryable.
 */
export function isDiffServerError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && status >= 500 && status <= 599;
}

/**
 * GitHub's `pulls.listFiles` is paginated and capped at 3000 files. A PR
 * that returns the cap almost certainly has more — there's no patch-level
 * data past it, so it's genuinely unreviewable via the API.
 */
export const LISTFILES_HARD_CAP = 3000;

/**
 * Byte budget for the full-patch portion of a reconstructed diff. Sized
 * well under the runner's MAX_DIFF_BYTES (1 MB) so that even a worst-case
 * name-only manifest (~3000 files) plus the fence, PR metadata, CI summary
 * and the model's echoed caveat still clears that cap — otherwise
 * assertDiffSize would skip the very PR we just rebuilt to review.
 */
export const RECONSTRUCT_BUDGET_BYTES = 600_000;

/**
 * Lockfiles, vendored trees and generated/minified artifacts. These get
 * manifest-only treatment (name + counts, no patch) so their churn never
 * crowds real code out of the review window. They still appear in the
 * count so the reviewer knows they changed.
 */
const NOISE_RE =
  /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$|(^|\/)(node_modules|vendor|dist|build|out|coverage|\.next|__generated__|__snapshots__)\/|\.(min\.js|min\.css|map|snap)$/i;

/** Subset of GitHub's pull-request file object we rely on. */
export type ChangedFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
};

export type AssembledDiff = {
  /** Synthetic unified diff: full per-file patches + a name-only manifest. */
  diff: string;
  /** Human-readable coverage line; surfaced to the model and the review. */
  notice: string;
};

function renderFileBlock(f: ChangedFile): string {
  // GitHub's `patch` starts at the first `@@` hunk. Prepend a git-style
  // header so the model reads file boundaries (and add/remove/rename)
  // unambiguously across the concatenation.
  const from =
    f.status === 'added' ? '/dev/null' : `a/${f.previous_filename ?? f.filename}`;
  const to = f.status === 'removed' ? '/dev/null' : `b/${f.filename}`;
  return `diff --git a/${f.filename} b/${f.filename}\n--- ${from}\n+++ ${to}\n${f.patch}`;
}

/**
 * Build a reviewable synthetic diff from a PR's file list when GitHub
 * refuses the single-blob diff. Pure (no network) so it's unit-testable.
 *
 * Strategy (chosen with the user): drop noise (lockfiles/generated) to
 * manifest-only, then include real code patches smallest-change-first so
 * the most files fit the byte budget. Everything not included in full is
 * listed by name with its add/delete counts. The `notice` instructs the
 * model to open with a visible "partial review of a large PR" caveat.
 *
 * Throws DiffTooManyFilesError only for the genuine residual: at/over the
 * listFiles cap, an empty list, or nothing reviewable fit (all
 * noise/binary) — a manifest-only "review" would be misleading noise.
 */
export function assembleLargeDiff(
  files: ChangedFile[],
  repoFull: string,
  pullNumber: number,
  budgetBytes: number = RECONSTRUCT_BUDGET_BYTES,
): AssembledDiff {
  if (files.length === 0 || files.length >= LISTFILES_HARD_CAP) {
    throw new DiffTooManyFilesError(repoFull, pullNumber);
  }

  const candidates: ChangedFile[] = [];
  const manifestOnly: ChangedFile[] = [];
  for (const f of files) {
    // No `patch` = binary or an individually-oversized file diff GitHub
    // itself elided. Noise = lockfile/generated. Both go manifest-only.
    if (!f.patch || NOISE_RE.test(f.filename)) manifestOnly.push(f);
    else candidates.push(f);
  }
  candidates.sort((a, b) => (a.changes ?? 0) - (b.changes ?? 0));

  const blocks: string[] = [];
  let bytes = 0;
  let included = 0;
  for (const f of candidates) {
    const block = renderFileBlock(f);
    const b = Buffer.byteLength(block, 'utf8') + 1; // +1 for the join newline
    if (bytes + b > budgetBytes) {
      manifestOnly.push(f);
      continue;
    }
    blocks.push(block);
    bytes += b;
    included++;
  }
  if (included === 0) {
    throw new DiffTooManyFilesError(repoFull, pullNumber);
  }

  const overCap = files.length >= LISTFILES_HARD_CAP;
  const manifest = manifestOnly
    .map(
      (f) => `  ${f.filename}  (+${f.additions}/-${f.deletions}, ${f.status})`,
    )
    .join('\n');
  const notice =
    `This pull request exceeds GitHub's single-diff limit ` +
    `(${files.length}${overCap ? '+' : ''} changed files). ` +
    `Reviewed in FULL: ${included} file(s). ` +
    `Listed by name only (patch elided to fit the review window): ` +
    `${manifestOnly.length} file(s). Begin your review with a clearly ` +
    `visible note that this is a PARTIAL review of a large PR so it is ` +
    `not mistaken for an exhaustive pass.`;
  const diff =
    blocks.join('\n') +
    (manifestOnly.length
      ? `\n\n# Files changed but not shown above (name only):\n${manifest}\n`
      : '');
  return { diff, notice };
}

/** What GitHub's compare API gives us, reduced to the fields the delta
 *  decision needs. `commits` carries parent counts so a merge-from-base
 *  (which pollutes the delta with upstream changes) is detectable. */
export type CompareResult = {
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  files: ChangedFile[];
  /** Parent count per commit in the range, in order. */
  commitParentCounts: number[];
};

/** GitHub's compare endpoint silently caps `files` at 300 — at the cap the
 *  list may be truncated, so a delta built from it could miss changes. */
const COMPARE_FILES_CAP = 300;

export type CompareDelta = {
  /** Synthetic unified diff of only the compared range. */
  diff: string;
  /** Files rendered in full (files without a patch — binaries — are skipped). */
  filesShown: number;
};

/**
 * Decide whether a compare result is a clean, trustworthy delta and build
 * the diff from it. Pure — unit-tested without the network. Returns null
 * (caller falls back to a full review) when:
 *  - status isn't 'ahead' (force-push/rebase ⇒ 'diverged'; 'identical'
 *    means nothing to review incrementally),
 *  - any commit in the range is a merge (base-branch merge-ins drag the
 *    whole upstream diff into the delta),
 *  - the file list is empty, at GitHub's 300-file cap (possibly
 *    truncated), or contains only binary/patch-less files.
 */
export function assembleCompareDelta(cmp: CompareResult): CompareDelta | null {
  if (cmp.status !== 'ahead') return null;
  if (cmp.commitParentCounts.some((n) => n > 1)) return null;
  if (cmp.files.length === 0 || cmp.files.length >= COMPARE_FILES_CAP) return null;
  const withPatch = cmp.files.filter((f) => f.patch);
  if (withPatch.length === 0) return null;
  return {
    diff: withPatch.map(renderFileBlock).join('\n'),
    filesShown: withPatch.length,
  };
}

/**
 * Fetch the compare-delta between a previously reviewed head and the
 * current one. Best-effort by design: any API failure, or a compare that
 * isn't a clean fast-forward (see assembleCompareDelta), returns null and
 * the caller reviews the full PR diff instead — incremental review is an
 * optimization, never a correctness dependency.
 */
export async function fetchCompareDelta(
  token: string,
  repoFull: string,
  baseSha: string,
  headSha: string,
): Promise<CompareDelta | null> {
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) return null;
  try {
    const octokit = octokitFor(token);
    const cmp = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseSha}...${headSha}`,
    });
    return assembleCompareDelta({
      status: cmp.data.status as CompareResult['status'],
      files: (cmp.data.files ?? []) as ChangedFile[],
      commitParentCounts: (cmp.data.commits ?? []).map(
        (c) => c.parents?.length ?? 1,
      ),
    });
  } catch (err) {
    console.warn(
      `[pulls] compare ${baseSha.slice(0, 8)}...${headSha.slice(0, 8)} for ` +
        `${repoFull} failed; falling back to full review: ` +
        `${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
    );
    return null;
  }
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
): Promise<{ pr: PRDetails; diff: string; diffNotice: string | null }> {
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFull: ${repoFull}`);

  const octokit = octokitFor(token);

  const meta = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });

  let diff: string;
  let diffNotice: string | null = null;
  try {
    const diffResp = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: { format: 'diff' },
    });
    diff = diffResp.data as unknown as string;
  } catch (err) {
    // GitHub refuses the single-blob diff over its size limits (>300
    // files / >20000 lines, `code: too_large`), and times out generating
    // expensive diffs (5xx "Unicorn!" HTML page). Don't give up — rebuild
    // a reviewable diff from the paginated file list (its own suggested
    // fallback). assembleLargeDiff throws DiffTooManyFilesError only for
    // the genuine residual (>=3000 files / nothing reviewable), which the
    // worker still marks `skipped`.
    if (!isTooLargeDiffError(err) && !isDiffServerError(err)) throw err;
    const files = (await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    })) as ChangedFile[];
    const assembled = assembleLargeDiff(files, repoFull, pullNumber);
    diff = assembled.diff;
    diffNotice = assembled.notice;
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
    diff,
    diffNotice,
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
 * Always includes `is:pr is:open archived:false` — GitHub search matches
 * archived repos by default, and a read-only repo can't take a review
 * post, so polling them only manufactures unpostable queue rows. Extra
 * terms appended as-is.
 */
function buildSearchQuery(targets: ScopeTarget[], extra: string[] = []): string {
  const terms = targets.map((t) =>
    t.kind === 'org' ? `org:${t.target}` : `repo:${t.target}`,
  );
  return ['is:pr', 'is:open', 'archived:false', ...terms, ...extra].join(' ');
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
