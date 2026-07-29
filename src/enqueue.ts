// The single decision point for "should this (user, PR) become a queued
// review, and with what settings?". Both the poller (iterating a user's
// open PRs) and the webhook receiver (one PR, fanned across users) call
// this, so the matching + filtering + scope-snapshot mapping can't drift
// between the two ingestion paths.

import { config } from './config.ts';
import { sql } from './db.ts';
import { matchScope } from './scope.ts';
import { listScopes, type Scope } from './db/scopes.ts';
import {
  countCommentTriggeredAtHead,
  enqueueReview,
  findLatestReviewForPR,
  findPriorReviewForPR,
  type PendingReview,
} from './db/reviews.ts';
import { fetchPullRequest, type PRDetails } from './github/pulls.ts';
import type { ParsedIssueCommentEvent } from './github/webhook.ts';

/** Comment-triggered re-reviews allowed per (user, repo, PR, head SHA).
 *  These rows are exempt from the idempotency index by design — stacking on
 *  an unchanged head is the entire point — so this cap is the only thing
 *  between a chatty thread and an unbounded review loop. Three allows a
 *  genuine back-and-forth; past that the humans should just talk. */
export const MAX_COMMENT_REREVIEWS_PER_HEAD = 3;

/** A PR plus the flag for review-requested gating. The poller sets it from
 *  its GraphQL `review-requested:` search (covers team-routed requests);
 *  the webhook path sets it per user from the payload's direct
 *  `requested_reviewers` list. */
export type MatchablePR = PRDetails & { reviewRequestedForViewer?: boolean };

export type EnqueueDecision = {
  /** The enqueued row, or null if filtered out OR idempotency-skipped. */
  review: PendingReview | null;
  /** The scope that matched and passed all gates (for logging), else null. */
  matched: Scope | null;
};

/**
 * Apply the same filters the poller always used — auto-merge skip,
 * scope match (first rule wins; self/excluded authors handled by
 * matchScope), and trigger-mode gating — then enqueue with the scope's
 * snapshotted settings. enqueueReview is idempotent on
 * (repo, pr#, head_sha), so the poller and a webhook firing for the same
 * push collapse to one row.
 */
export async function enqueueForUser(args: {
  userId: number;
  selfLogin: string;
  scopes: Scope[];
  pr: MatchablePR;
}): Promise<EnqueueDecision> {
  const { userId, selfLogin, scopes, pr } = args;

  // Author has opted into "merge when ready" — a generated review is wasted
  // effort and may comment on a PR that's about to vanish.
  if (pr.autoMerge) return { review: null, matched: null };

  const matched = matchScope(pr, scopes, selfLogin);
  if (!matched) return { review: null, matched: null };

  // review_requested scopes only fire when GitHub's review-requested
  // signal (poller GraphQL) flagged this PR for the viewer/their teams.
  if (
    matched.triggerMode === 'review_requested' &&
    !pr.reviewRequestedForViewer
  ) {
    return { review: null, matched: null };
  }

  const claudeMode =
    matched.claudeMode === 'default'
      ? config.claude.defaultMode
      : matched.claudeMode;

  // Incremental re-review candidate: the PR's latest completed review, if
  // the scope opted in (default on). Snapshotted here; the worker decides
  // at run time whether the compare-delta is clean enough to use.
  const prior = matched.incrementalRereview
    ? await findPriorReviewForPR(userId, pr.repoFull, pr.number)
    : null;

  const review = await enqueueReview({
    userId,
    scopeId: matched.id,
    repoFull: pr.repoFull,
    prNumber: pr.number,
    prTitle: pr.title,
    prAuthor: pr.author,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    headSha: pr.headSha,
    scrutiny: matched.scrutiny,
    claudeMode,
    autoApprove: matched.autoApprove,
    gateOnBlocking: matched.gateOnBlocking,
    footerTemplate: matched.footerTemplate,
    personalityPrompt: matched.personalityPrompt,
    humanize: matched.humanize,
    reviewerSkill: matched.reviewerSkill,
    reviewContext: matched.reviewContext,
    priorReviewId: prior?.id ?? null,
    priorHeadSha: prior?.headSha ?? null,
  });
  return { review, matched };
}

/**
 * Fan one PR (from a webhook delivery) across every user that has at least
 * one enabled scope, enqueuing where a scope matches. Mirrors the poller's
 * user query so both ingestion paths see the same population. Returns the
 * number of rows enqueued. enqueueReview's idempotency means a webhook and
 * the poller racing on the same push can't double-enqueue.
 *
 * `requestedReviewers` (lowercased logins from the delivery payload) drives
 * review_requested-mode scopes: a user on that list gets the instant
 * webhook path. Team-routed requests aren't resolvable from the payload
 * alone, so those users still get picked up by the poller's GraphQL search
 * within the poll interval.
 */
export async function enqueueAcrossUsers(
  pr: MatchablePR,
  requestedReviewers: string[] = [],
): Promise<number> {
  const users = await sql<{ id: number; login: string }[]>`
    SELECT DISTINCT u.id, u.github_login AS login
    FROM users u
    JOIN scopes s ON s.user_id = u.id
    WHERE s.enabled = TRUE
  `;
  let enqueued = 0;
  for (const u of users) {
    const scopes = (await listScopes(u.id)).filter((s) => s.enabled);
    if (scopes.length === 0) continue;
    const { review, matched } = await enqueueForUser({
      userId: u.id,
      selfLogin: u.login,
      scopes,
      pr: {
        ...pr,
        reviewRequestedForViewer: requestedReviewers.includes(
          u.login.toLowerCase(),
        ),
      },
    });
    if (review && matched) {
      enqueued++;
      console.log(
        `[webhook] enqueued #${review.id} ${pr.repoFull}#${pr.number} ` +
          `(user ${u.login}, scope ${matched.id}, scrutiny=${matched.scrutiny})`,
      );
    }
  }
  return enqueued;
}

/**
 * A PR author replied to a review. Enqueue a re-review for every user whose
 * latest review of that PR is a `request-changes` still sitting on the
 * current head.
 *
 * This exists because a blocking review used to be unanswerable. Only a
 * push re-ran arbiter, so when the blocker was a question — or simply
 * wrong — the author could reply with the correct answer and nothing would
 * ever read it. The block stood until they pushed a commit they didn't
 * need. Prose is now a valid way to clear one.
 *
 * Every gate here exists to keep that narrow:
 * - latest review must be `request-changes` (a later `approve` means
 *   nothing is blocked, and the old finding must not be resurrected)
 * - it must have run at the PR's CURRENT head (if the head moved, the
 *   `synchronize` path already re-reviewed and the finding is stale)
 * - the PR must still match an enabled scope, so turning arbiter off for a
 *   repo turns this off too
 * - at most MAX_COMMENT_REREVIEWS_PER_HEAD per head SHA
 *
 * The PR fetch is deliberately after the DB gate and memoized across users:
 * the `issue_comment` payload has no head SHA, and most deliveries stop at
 * the DB check without ever touching the API.
 */
export async function enqueueCommentReplyAcrossUsers(
  ev: ParsedIssueCommentEvent,
): Promise<number> {
  const users = await sql<{ id: number; login: string; token: string }[]>`
    SELECT DISTINCT u.id, u.github_login AS login, u.github_token AS token
    FROM users u
    JOIN scopes s ON s.user_id = u.id
    WHERE s.enabled = TRUE
  `;

  let pr: PRDetails | null = null;
  let enqueued = 0;

  for (const u of users) {
    const latest = await findLatestReviewForPR(u.id, ev.repoFull, ev.prNumber);
    if (!latest || latest.verdict !== 'request-changes') continue;

    const scopes = (await listScopes(u.id)).filter((s) => s.enabled);
    if (scopes.length === 0) continue;

    // The first user past the DB gate pays for the PR fetch and the rest
    // reuse it — the metadata is the same whoever asks. A failure is NOT
    // cached: this user's token may simply have been revoked, and that must
    // not silently disqualify everyone behind them. The gate above already
    // keeps this to the handful of users holding a blocking review on this
    // exact PR, so retrying per user costs at most a few calls.
    if (!pr) {
      try {
        pr = (await fetchPullRequest(u.token, ev.repoFull, ev.prNumber)).pr;
      } catch (err) {
        console.error(
          `[webhook] comment re-review: ${u.login} could not fetch ` +
            `${ev.repoFull}#${ev.prNumber}:`,
          err,
        );
        continue;
      }
    }

    // The reply has to be answering a review of the code as it stands.
    if (pr.headSha !== latest.headSha) continue;
    if (pr.draft || pr.autoMerge) continue;

    const matched = matchScope(pr, scopes, u.login);
    if (!matched) continue;

    const already = await countCommentTriggeredAtHead(
      u.id,
      ev.repoFull,
      ev.prNumber,
      pr.headSha,
    );
    if (already >= MAX_COMMENT_REREVIEWS_PER_HEAD) {
      console.log(
        `[webhook] comment re-review capped for ${ev.repoFull}#${ev.prNumber} ` +
          `(user ${u.login}, ${already}/${MAX_COMMENT_REREVIEWS_PER_HEAD} at ` +
          `${pr.headSha.slice(0, 8)})`,
      );
      continue;
    }

    const claudeMode =
      matched.claudeMode === 'default'
        ? config.claude.defaultMode
        : matched.claudeMode;

    const review = await enqueueReview({
      userId: u.id,
      scopeId: matched.id,
      repoFull: pr.repoFull,
      prNumber: pr.number,
      prTitle: pr.title,
      prAuthor: pr.author,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      headSha: pr.headSha,
      scrutiny: matched.scrutiny,
      claudeMode,
      autoApprove: matched.autoApprove,
      gateOnBlocking: matched.gateOnBlocking,
      footerTemplate: matched.footerTemplate,
      personalityPrompt: matched.personalityPrompt,
      humanize: matched.humanize,
      reviewerSkill: matched.reviewerSkill,
      reviewContext: matched.reviewContext,
      trigger: 'comment',
      // Always carried, independent of the scope's incremental setting: the
      // whole point is to re-read the review being replied to. The worker
      // sees priorHeadSha === headSha and so reviews the FULL diff with the
      // prior review plus the reply as context, never a (empty) delta.
      priorReviewId: latest.id,
      priorHeadSha: latest.headSha,
    });
    if (review) {
      enqueued++;
      console.log(
        `[webhook] enqueued #${review.id} ${pr.repoFull}#${pr.number} ` +
          `(comment reply from ${ev.commenter}, user ${u.login}, ` +
          `scope ${matched.id})`,
      );
    }
  }
  return enqueued;
}
