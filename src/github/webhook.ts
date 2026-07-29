// GitHub webhook receiver helpers — signature verification and payload
// parsing. Kept pure (no DB, no network) so they unit-test directly; the
// route in web/server.tsx does the I/O and the enqueue dispatch.

import type { PRDetails } from './pulls.ts';

// Pull-request actions worth a (re)review. Deliberately excludes `edited`,
// `labeled`, `closed`, `assigned`, etc. `review_requested` fires when a
// reviewer is added — the payload's `requested_reviewers` list lets
// review_requested-mode scopes trigger instantly for directly-requested
// users. Team-routed requests still rely on the poller: resolving team
// membership needs the GraphQL search it already does.
// `ready_for_review` covers the draft→ready transition.
const RELEVANT_ACTIONS = new Set([
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
  'review_requested',
]);

const encoder = new TextEncoder();

/**
 * Verify GitHub's `X-Hub-Signature-256` over the RAW request body.
 * Header form is `sha256=<hex>`. Returns false for any missing/!malformed
 * input rather than throwing, and compares in constant time so a timing
 * side-channel can't probe the digest.
 */
export async function verifyGithubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null | undefined,
): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) return false;
  const provided = signatureHeader.slice(expectedPrefix.length);

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const computed = [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeEqual(computed, provided.toLowerCase());
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Length-independent constant-time string compare (hex digests). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type GhPullRequestPayload = {
  action?: unknown;
  number?: unknown;
  repository?: { full_name?: unknown };
  pull_request?: {
    title?: unknown;
    user?: { login?: unknown };
    base?: { ref?: unknown };
    head?: { ref?: unknown; sha?: unknown };
    draft?: unknown;
    auto_merge?: unknown;
    requested_reviewers?: unknown;
    requested_teams?: unknown;
  };
};

export type ParsedPullRequestEvent = {
  action: string;
  pr: PRDetails;
  /** Logins (lowercased) with a pending direct review request on this PR.
   *  GitHub clears a login from this list once that review is submitted. */
  requestedReviewers: string[];
  /** Slugs of teams with a pending review request. Not resolved to members
   *  here — team-routed requests stay poller-driven (GraphQL search). */
  requestedTeams: string[];
};

/**
 * Normalize a `pull_request` webhook into the same PRDetails the poller
 * produces, or null when this delivery should be ignored: wrong event,
 * uninteresting action, a draft PR, or a payload missing fields we need.
 * Draft PRs are skipped (the `ready_for_review` action carries draft:false
 * and is what triggers their first review) — mirrors the poller, which
 * filters drafts out of its search results.
 */
export function parsePullRequestEvent(
  eventName: string | null | undefined,
  payload: unknown,
): ParsedPullRequestEvent | null {
  if (eventName !== 'pull_request') return null;
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as GhPullRequestPayload;

  const action = typeof p.action === 'string' ? p.action : '';
  if (!RELEVANT_ACTIONS.has(action)) return null;

  const number = typeof p.number === 'number' ? p.number : NaN;
  const repoFull =
    typeof p.repository?.full_name === 'string' ? p.repository.full_name : '';
  const pull = p.pull_request;
  if (!pull || !repoFull || !Number.isInteger(number) || number <= 0) {
    return null;
  }

  const draft = pull.draft === true;
  if (draft) return null; // never review a draft

  const title = typeof pull.title === 'string' ? pull.title : '';
  const author =
    typeof pull.user?.login === 'string' ? pull.user.login : 'unknown';
  const baseBranch = typeof pull.base?.ref === 'string' ? pull.base.ref : '';
  const headBranch = typeof pull.head?.ref === 'string' ? pull.head.ref : '';
  const headSha = typeof pull.head?.sha === 'string' ? pull.head.sha : '';
  if (!baseBranch || !headSha) return null;

  const requestedReviewers = Array.isArray(pull.requested_reviewers)
    ? pull.requested_reviewers
        .map((r) => asString((r as { login?: unknown })?.login)?.toLowerCase())
        .filter((x): x is string => !!x)
    : [];
  const requestedTeams = Array.isArray(pull.requested_teams)
    ? pull.requested_teams
        .map((t) => asString((t as { slug?: unknown })?.slug))
        .filter((x): x is string => !!x)
    : [];

  return {
    action,
    requestedReviewers,
    requestedTeams,
    pr: {
      repoFull,
      number,
      title,
      author,
      baseBranch,
      headBranch,
      headSha,
      draft: false,
      autoMerge: pull.auto_merge != null,
    },
  };
}

type GhIssueCommentPayload = {
  action?: unknown;
  repository?: { full_name?: unknown };
  issue?: {
    number?: unknown;
    pull_request?: unknown;
    user?: { login?: unknown };
    state?: unknown;
  };
  comment?: {
    body?: unknown;
    user?: { login?: unknown; type?: unknown };
  };
};

export type ParsedIssueCommentEvent = {
  repoFull: string;
  prNumber: number;
  /** Login of the commenter, as delivered (not lowercased). */
  commenter: string;
  /** Login of the PR author, as delivered. */
  prAuthor: string;
  body: string;
};

/**
 * Normalize an `issue_comment` delivery into the fields the re-review gate
 * needs, or null when it isn't a PR-author reply worth acting on.
 *
 * This is the escape hatch from a deadlock: a review that blocks on a
 * question the author can answer in prose but cannot "fix" in code. Because
 * only a push re-ran arbiter, answering it did nothing at all. So the bar
 * here is deliberately narrow — the comment must be newly created (not
 * edited), on a pull request rather than a plain issue, on an open PR, and
 * written by the PR's own author. Everyone else's comments, and arbiter's
 * own, are ignored: a bot replying to a bot is how you build a loop.
 */
export function parseIssueCommentEvent(
  eventName: string | null | undefined,
  payload: unknown,
): ParsedIssueCommentEvent | null {
  if (eventName !== 'issue_comment') return null;
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as GhIssueCommentPayload;

  // `edited`/`deleted` deliberately excluded: re-running on an edit lets a
  // single comment trigger unbounded reviews.
  if (p.action !== 'created') return null;

  // `issue.pull_request` is present only when the issue IS a PR.
  if (p.issue?.pull_request == null) return null;
  if (p.issue?.state !== 'open') return null;

  const repoFull = asString(p.repository?.full_name);
  const prNumber = typeof p.issue?.number === 'number' ? p.issue.number : NaN;
  const commenter = asString(p.comment?.user?.login);
  const prAuthor = asString(p.issue?.user?.login);
  const body = typeof p.comment?.body === 'string' ? p.comment.body : '';
  if (!repoFull || !commenter || !prAuthor) return null;
  if (!Number.isInteger(prNumber) || prNumber <= 0) return null;
  if (body.trim().length === 0) return null;

  // Only the author's own reply counts. A third party arguing with the
  // review isn't the one who has to unblock it, and this keeps the trigger
  // off PR comment threads generally.
  if (commenter.toLowerCase() !== prAuthor.toLowerCase()) return null;

  // Belt-and-braces against bot loops even if a bot authored the PR.
  if (p.comment?.user?.type === 'Bot') return null;

  return { repoFull, prNumber, commenter, prAuthor, body };
}
