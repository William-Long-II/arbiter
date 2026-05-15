// The single decision point for "should this (user, PR) become a queued
// review, and with what settings?". Both the poller (iterating a user's
// open PRs) and the webhook receiver (one PR, fanned across users) call
// this, so the matching + filtering + scope-snapshot mapping can't drift
// between the two ingestion paths.

import { config } from './config.ts';
import { sql } from './db.ts';
import { matchScope } from './scope.ts';
import { listScopes, type Scope } from './db/scopes.ts';
import { enqueueReview, type PendingReview } from './db/reviews.ts';
import type { PRDetails } from './github/pulls.ts';

/** A PR plus the poller-only flag for review-requested gating. The webhook
 *  path leaves it undefined (review_requested scopes stay poller-driven). */
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
    footerTemplate: matched.footerTemplate,
    personalityPrompt: matched.personalityPrompt,
    reviewContext: matched.reviewContext,
  });
  return { review, matched };
}

/**
 * Fan one PR (from a webhook delivery) across every user that has at least
 * one enabled scope, enqueuing where a scope matches. Mirrors the poller's
 * user query so both ingestion paths see the same population. Returns the
 * number of rows enqueued. enqueueReview's idempotency means a webhook and
 * the poller racing on the same push can't double-enqueue.
 */
export async function enqueueAcrossUsers(pr: MatchablePR): Promise<number> {
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
      pr,
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
