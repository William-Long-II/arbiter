import { sql } from '../db.ts';
import type { ClaudeMode, Scrutiny } from './scopes.ts';

export type ReviewStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

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
  status: ReviewStatus;
  attempt: number;
  error: string | null;
  output: string | null;
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
};

/**
 * Insert a review into the queue. The unique index on
 * (repo_full, pr_number, head_sha) makes this idempotent — pushing more
 * commits to the PR creates a new row; re-running on the same SHA does not.
 * Returns the row, or null if a row for this SHA already existed.
 */
export async function enqueueReview(input: EnqueueInput): Promise<PendingReview | null> {
  const rows = await sql<PendingReview[]>`
    INSERT INTO pending_reviews (
      user_id, scope_id, repo_full, pr_number, pr_title, pr_author,
      base_branch, head_branch, head_sha, scrutiny, claude_mode, status
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
      'queued'
    )
    ON CONFLICT (repo_full, pr_number, head_sha) DO NOTHING
    RETURNING
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
      status,
      attempt,
      error,
      output,
      created_at   AS "createdAt",
      started_at   AS "startedAt",
      finished_at  AS "finishedAt"
  `;
  return rows[0] ?? null;
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
    RETURNING
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
      status,
      attempt,
      error,
      output,
      created_at   AS "createdAt",
      started_at   AS "startedAt",
      finished_at  AS "finishedAt"
  `;
  return rows[0] ?? null;
}

export async function markDone(id: number, output: string): Promise<void> {
  await sql`
    UPDATE pending_reviews
    SET status = 'done',
        finished_at = now(),
        output = ${output},
        error = null
    WHERE id = ${id}
  `;
}

export async function markFailed(id: number, error: string): Promise<void> {
  await sql`
    UPDATE pending_reviews
    SET status = 'failed',
        finished_at = now(),
        error = ${error}
    WHERE id = ${id}
  `;
}

export async function listReviews(userId: number, limit = 50): Promise<PendingReview[]> {
  return sql<PendingReview[]>`
    SELECT
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
      status,
      attempt,
      error,
      output,
      created_at   AS "createdAt",
      started_at   AS "startedAt",
      finished_at  AS "finishedAt"
    FROM pending_reviews
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

export async function getReview(userId: number, id: number): Promise<PendingReview | null> {
  const rows = await sql<PendingReview[]>`
    SELECT
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
      status,
      attempt,
      error,
      output,
      created_at   AS "createdAt",
      started_at   AS "startedAt",
      finished_at  AS "finishedAt"
    FROM pending_reviews
    WHERE id = ${id} AND user_id = ${userId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}
