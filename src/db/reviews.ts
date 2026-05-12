import { sql } from '../db.ts';
import type { ClaudeMode, Scrutiny } from './scopes.ts';
import type { Verdict } from '../review/format.ts';
import type { ReviewEvent } from '../events.ts';

export type ReviewStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';
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
  status: ReviewStatus;
  attempt: number;
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
  status,
  attempt,
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
      auto_approve, footer_template, status
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
        started_at = now(),
        attempt = attempt + 1
    WHERE id = (
      SELECT id FROM pending_reviews
      WHERE status = 'queued'
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

export async function markDone(
  id: number,
  output: string,
  verdict: Verdict,
  postedEvent: PostedEvent,
): Promise<void> {
  const rows = await sql<PendingReview[]>`
    UPDATE pending_reviews
    SET status = 'done',
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

export async function markFailed(id: number, error: string): Promise<void> {
  const rows = await sql<PendingReview[]>`
    UPDATE pending_reviews
    SET status = 'failed',
        finished_at = now(),
        error = ${error}
    WHERE id = ${id}
    RETURNING ${SELECT_REVIEW_COLUMNS}
  `;
  if (rows[0]) await notifyReviewChanged(rows[0]);
}

export async function listReviews(userId: number, limit = 50): Promise<PendingReview[]> {
  return sql<PendingReview[]>`
    SELECT ${SELECT_REVIEW_COLUMNS}
    FROM pending_reviews
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
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
