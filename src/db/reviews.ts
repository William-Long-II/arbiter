import { sql } from '../db.ts';
import type { ClaudeMode, ReviewContext, Scrutiny } from './scopes.ts';
import type { Verdict } from '../review/format.ts';
import type { ReviewEvent } from '../events.ts';

export type ReviewStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';
/** Sub-status of a `running` review. NULL in every other status. */
export type ReviewPhase = 'preparing' | 'reviewing' | 'posting';
export type PostedEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export type PendingReview = {
  id: number;
  userId: number;
  scopeId: number | null;
  repoFull: string;
  prNumber: number;
  prTitle: string;
  prAuthor: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  scrutiny: Scrutiny;
  claudeMode: Exclude<ClaudeMode, 'default'>;
  autoApprove: boolean;
  /** Snapshotted from the matching scope at enqueue time. See db/scopes.ts. */
  footerTemplate: string | null;
  /** Snapshotted from the matching scope at enqueue time. See db/scopes.ts. */
  personalityPrompt: string | null;
  /** Snapshotted from the matching scope at enqueue time. What the
   * reviewer subprocess sees ('isolated' default | 'checkout'). */
  reviewContext: ReviewContext;
  status: ReviewStatus;
  /** Sub-status while status === 'running'; null otherwise. */
  phase: ReviewPhase | null;
  attempt: number;
  /** When set + in the future, the worker's claim query skips this row.
   *  Used to wait out pending CI before reviewing. See deferReview. */
  deferUntil: Date | null;
  /** Bumped each time the row is deferred. Bounded; the worker proceeds
   *  once defer_count crosses MAX_DEFERS regardless of CI state. */
  deferCount: number;
  error: string | null;
  output: string | null;
  verdict: Verdict | null;
  postedEvent: PostedEvent | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export type EnqueueInput = {
  userId: number;
  scopeId?: number | null;
  repoFull: string;
  prNumber: number;
  prTitle: string;
  prAuthor: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  scrutiny: Scrutiny;
  claudeMode: Exclude<ClaudeMode, 'default'>;
  autoApprove: boolean;
  footerTemplate: string | null;
  personalityPrompt: string | null;
  reviewContext: ReviewContext;
};

const SELECT_REVIEW_COLUMNS = sql`
  id,
  user_id      AS "userId",
  scope_id     AS "scopeId",
  repo_full    AS "repoFull",
  pr_number    AS "prNumber",
  pr_title     AS "prTitle",
  pr_author    AS "prAuthor",
  base_branch  AS "baseBranch",
  head_branch  AS "headBranch",
  head_sha     AS "headSha",
  scrutiny,
  claude_mode  AS "claudeMode",
  auto_approve AS "autoApprove",
  footer_template AS "footerTemplate",
  personality_prompt AS "personalityPrompt",
  review_context AS "reviewContext",
  status,
  phase,
  attempt,
  defer_until  AS "deferUntil",
  defer_count  AS "deferCount",
  error,
  output,
  verdict,
  posted_event AS "postedEvent",
  created_at   AS "createdAt",
  started_at   AS "startedAt",
  finished_at  AS "finishedAt"
`;

/**
 * Insert a review into the queue. The unique index on
 * (repo_full, pr_number, head_sha) makes this idempotent — pushing more
 * commits to the PR creates a new row; re-running on the same SHA does not.
 * Returns the row, or null if a row for this SHA already existed.
 */
/**
 * Fire a Postgres NOTIFY on `reviews_changed` so the in-process events
 * bus (started by startEventListener in db.ts) can fan it out to any
 * subscribed SSE clients. Cheap and asynchronous; no transactional
 * coupling to the row update — if the NOTIFY is missed, the next
 * load of /queue still shows the current state.
 */
async function notifyReviewChanged(review: PendingReview): Promise<void> {
  const event: ReviewEvent = {
    userId: review.userId,
    reviewId: review.id,
    status: review.status,
    phase: review.phase ?? null,
    verdict: review.verdict,
    postedEvent: review.postedEvent,
    startedAt: review.startedAt ? review.startedAt.toISOString() : null,
    finishedAt: review.finishedAt ? review.finishedAt.toISOString() : null,
  };
  await sql`SELECT pg_notify('reviews_changed', ${JSON.stringify(event)})`;
}

export async function enqueueReview(input: EnqueueInput): Promise<PendingReview | null> {
  const rows = await sql<PendingReview[]>`
    INSERT INTO pending_reviews (
      user_id, scope_id, repo_full, pr_number, pr_title, pr_author,
      base_branch, head_branch, head_sha, scrutiny, claude_mode,
      auto_approve, footer_template, personality_prompt, review_context,
      status
    ) VALUES (
      ${input.userId},
      ${input.scopeId ?? null},
      ${input.repoFull},
      ${input.prNumber},
      ${input.prTitle},
      ${input.prAuthor},
      ${input.baseBranch},
      ${input.headBranch},
      ${input.headSha},
      ${input.scrutiny},
      ${input.claudeMode},
      ${input.autoApprove},
      ${input.footerTemplate},
      ${input.personalityPrompt},
      ${input.reviewContext},
      'queued'
    )
    ON CONFLICT (repo_full, pr_number, head_sha) DO NOTHING
    RETURNING ${SELECT_REVIEW_COLUMNS}
  `;
  const row = rows[0] ?? null;
  if (row) await notifyReviewChanged(row);
  return row;
}

/**
 * Atomically claim the next queued review and mark it running.
 * Uses FOR UPDATE SKIP LOCKED so multiple workers (or restarts during a
 * stuck job) don't double-process. Returns null if the queue is empty.
 */
export async function claimNext(): Promise<PendingReview | null> {
  const rows = await sql<PendingReview[]>`
    UPDATE pending_reviews
    SET status = 'running',
        phase = 'preparing',
        started_at = now(),
        attempt = attempt + 1
    WHERE id = (
      SELECT id FROM pending_reviews
      WHERE status = 'queued'
        AND (defer_until IS NULL OR defer_until <= now())
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING ${SELECT_REVIEW_COLUMNS}
  `;
  const row = rows[0] ?? null;
  if (row) await notifyReviewChanged(row);
  return row;
}

/**
 * Send a claimed review back to the queue with a future defer_until
 * timestamp. The next worker tick after defer_until will pick it up
 * again. Bumps defer_count so the worker can bound the number of
 * deferrals before proceeding with whatever CI signal exists.
 */
export async function deferReview(id: number, deferSeconds: number): Promise<PendingReview | null> {
  const rows = await sql<PendingReview[]>`
    UPDATE pending_reviews
    SET status = 'queued',
        phase = NULL,
        defer_until = now() + (${deferSeconds} || ' seconds')::interval,
        defer_count = defer_count + 1,
        started_at = NULL
    WHERE id = ${id}
    RETURNING ${SELECT_REVIEW_COLUMNS}
  `;
  const row = rows[0] ?? null;
  if (row) await notifyReviewChanged(row);
  return row;
}

/**
 * Advance the sub-status of a running review (preparing → reviewing →
 * posting). Guarded on status='running' so a late call can't resurrect
 * phase on a row that already finished/failed. Fires the same NOTIFY as
 * status transitions, so /api/events/queue pushes it to the UI live —
 * this is the only signal emitted during the multi-minute claude call.
 */
export async function setReviewPhase(id: number, phase: ReviewPhase): Promise<void> {
  const rows = await sql<PendingReview[]>`
    UPDATE pending_reviews
    SET phase = ${phase}
    WHERE id = ${id} AND status = 'running'
    RETURNING ${SELECT_REVIEW_COLUMNS}
  `;
  if (rows[0]) await notifyReviewChanged(rows[0]);
}

export async function markDone(
  id: number,
  output: string,
  verdict: Verdict,
  postedEvent: PostedEvent,
): Promise<void> {
  const rows = await sql<PendingReview[]>`
    UPDATE pending_reviews
    SET status = 'done',
        phase = NULL,
        finished_at = now(),
        output = ${output},
        error = null,
        verdict = ${verdict},
        posted_event = ${postedEvent}
    WHERE id = ${id}
    RETURNING ${SELECT_REVIEW_COLUMNS}
  `;
  if (rows[0]) await notifyReviewChanged(rows[0]);
}

/**
 * Reset a failed review back to queued so the worker picks it up again.
 * Scoped to the requesting user (no cross-user retries) and gated on
 * status='failed' so it's a no-op for already-running, queued, or done
 * rows. The NOTIFY then wakes the worker immediately via the same
 * channel /api/events/queue uses, so the retry kicks in within ~10ms
 * rather than waiting for the 5s tick.
 *
 * Returns the updated row, or null if nothing matched.
 */
export async function retryFailedReview(
  userId: number,
  id: number,
): Promise<PendingReview | null> {
  const rows = await sql<PendingReview[]>`
    UPDATE pending_reviews
    SET status = 'queued',
        phase = null,
        error = null,
        started_at = null,
        finished_at = null,
        verdict = null,
        posted_event = null
    WHERE id = ${id}
      AND user_id = ${userId}
      AND status = 'failed'
    RETURNING ${SELECT_REVIEW_COLUMNS}
  `;
  const row = rows[0] ?? null;
  if (row) await notifyReviewChanged(row);
  return row;
}

export async function markFailed(id: number, error: string): Promise<void> {
  const rows = await sql<PendingReview[]>`
    UPDATE pending_reviews
    SET status = 'failed',
        phase = NULL,
        finished_at = now(),
        error = ${error}
    WHERE id = ${id}
    RETURNING ${SELECT_REVIEW_COLUMNS}
  `;
  if (rows[0]) await notifyReviewChanged(rows[0]);
}

/**
 * Mark a review as skipped — terminal but not "failed". Used for
 * structurally un-reviewable PRs (diff too large, too many files) where
 * retrying would just hit the same limit. The queue UI hides the retry
 * button on skipped rows.
 */
export async function markSkipped(id: number, reason: string): Promise<void> {
  const rows = await sql<PendingReview[]>`
    UPDATE pending_reviews
    SET status = 'skipped',
        phase = NULL,
        finished_at = now(),
        error = ${reason}
    WHERE id = ${id}
    RETURNING ${SELECT_REVIEW_COLUMNS}
  `;
  if (rows[0]) await notifyReviewChanged(rows[0]);
}

/**
 * Skip a review whose body was generated but couldn't be posted because
 * the PR conversation is locked. Unlike a structural skip (diff too
 * large), we KEEP the generated body + verdict + intended event so the
 * user can "Post anyway" once they unlock the PR. The detail page tells
 * the two skip kinds apart by `output IS NOT NULL` on a skipped row.
 */
export async function markSkippedPendingPost(
  id: number,
  reason: string,
  output: string,
  verdict: Verdict,
  postedEvent: PostedEvent,
): Promise<void> {
  const rows = await sql<PendingReview[]>`
    UPDATE pending_reviews
    SET status = 'skipped',
        phase = NULL,
        finished_at = now(),
        error = ${reason},
        output = ${output},
        verdict = ${verdict},
        posted_event = ${postedEvent}
    WHERE id = ${id}
    RETURNING ${SELECT_REVIEW_COLUMNS}
  `;
  if (rows[0]) await notifyReviewChanged(rows[0]);
}

export type ListReviewsOptions = {
  limit?: number;
  /** Restrict to these statuses. Empty/undefined = all. */
  statusFilter?: ReviewStatus[];
};

export async function listReviews(
  userId: number,
  opts: ListReviewsOptions = {},
): Promise<PendingReview[]> {
  const limit = opts.limit ?? 50;
  const statuses = opts.statusFilter;
  if (statuses && statuses.length > 0) {
    return sql<PendingReview[]>`
      SELECT ${SELECT_REVIEW_COLUMNS}
      FROM pending_reviews
      WHERE user_id = ${userId} AND status = ANY(${statuses})
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }
  return sql<PendingReview[]>`
    SELECT ${SELECT_REVIEW_COLUMNS}
    FROM pending_reviews
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

const ALL_STATUSES: readonly ReviewStatus[] = [
  'queued', 'running', 'done', 'failed', 'skipped',
];

export function isReviewStatus(v: string): v is ReviewStatus {
  return (ALL_STATUSES as readonly string[]).includes(v);
}

export async function getReview(userId: number, id: number): Promise<PendingReview | null> {
  const rows = await sql<PendingReview[]>`
    SELECT ${SELECT_REVIEW_COLUMNS}
    FROM pending_reviews
    WHERE id = ${id} AND user_id = ${userId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * A user-initiated override of the worker's auto-approval decision. Today
 * the only override type is `APPROVE` — the user posted an APPROVE on top
 * of a review that the worker had to send as COMMENT (verdict wasn't
 * `approve`, or scope auto-approve was off, or self-author guard). The
 * reason field, when set, is the user's explanation of why the flagged
 * issue should have been a suggestion — useful raw material for tuning
 * the scrutiny prompts later.
 */
export type ReviewOverride = {
  id: number;
  reviewId: number;
  userId: number;
  overrideEvent: 'APPROVE';
  reason: string | null;
  postedAt: Date;
};

const SELECT_OVERRIDE_COLUMNS = sql`
  id,
  review_id      AS "reviewId",
  user_id        AS "userId",
  override_event AS "overrideEvent",
  reason,
  posted_at      AS "postedAt"
`;

/**
 * Insert an approval-override row for a review. The unique index on
 * review_id makes this idempotent — a second click on "Approve anyway"
 * returns null instead of recording a duplicate.
 */
export async function recordApprovalOverride(
  reviewId: number,
  userId: number,
  reason: string | null,
): Promise<ReviewOverride | null> {
  const rows = await sql<ReviewOverride[]>`
    INSERT INTO review_overrides (review_id, user_id, override_event, reason)
    VALUES (${reviewId}, ${userId}, 'APPROVE', ${reason})
    ON CONFLICT (review_id) DO NOTHING
    RETURNING ${SELECT_OVERRIDE_COLUMNS}
  `;
  return rows[0] ?? null;
}

export async function getReviewOverride(
  reviewId: number,
): Promise<ReviewOverride | null> {
  const rows = await sql<ReviewOverride[]>`
    SELECT ${SELECT_OVERRIDE_COLUMNS}
    FROM review_overrides
    WHERE review_id = ${reviewId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * List other reviews for the same (repo, pr_number) — useful for the
 * detail page to show "this PR has been reviewed N times before."
 * Excludes the requesting review (via `excludeId`) so we don't echo
 * itself in its own sibling panel.
 */
export async function listReviewsForPR(
  userId: number,
  repoFull: string,
  prNumber: number,
  excludeId: number,
): Promise<PendingReview[]> {
  return sql<PendingReview[]>`
    SELECT ${SELECT_REVIEW_COLUMNS}
    FROM pending_reviews
    WHERE user_id = ${userId}
      AND repo_full = ${repoFull}
      AND pr_number = ${prNumber}
      AND id <> ${excludeId}
    ORDER BY created_at DESC
    LIMIT 20
  `;
}
