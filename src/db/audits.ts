// Persistence for Time Machine retro-audit runs (migration 019). An
// audit_run groups the report-only reviews spawned by one "audit the last
// N merged PRs" action; the reviews themselves live in pending_reviews
// (report_only = TRUE, audit_run_id = this run) and are listed via
// listReviewsForAuditRun in db/reviews.ts.

import { sql } from '../db.ts';
import type { ReviewContext, Scrutiny } from './scopes.ts';

export type AuditRun = {
  id: number;
  userId: number;
  repoFull: string;
  scrutiny: Scrutiny;
  reviewContext: ReviewContext;
  /** How many merged PRs the operator asked to audit. */
  requestedCount: number;
  /** How many report-only reviews were actually enqueued (≤ requested when
   *  the repo has fewer merged PRs than asked for). */
  enqueuedCount: number;
  createdAt: Date;
};

const SELECT_AUDIT_COLUMNS = sql`
  id,
  user_id        AS "userId",
  repo_full      AS "repoFull",
  scrutiny,
  review_context AS "reviewContext",
  requested_count AS "requestedCount",
  enqueued_count  AS "enqueuedCount",
  created_at     AS "createdAt"
`;

export async function createAuditRun(input: {
  userId: number;
  repoFull: string;
  scrutiny: Scrutiny;
  reviewContext: ReviewContext;
  requestedCount: number;
}): Promise<AuditRun> {
  const rows = await sql<AuditRun[]>`
    INSERT INTO audit_runs (
      user_id, repo_full, scrutiny, review_context, requested_count
    ) VALUES (
      ${input.userId},
      ${input.repoFull},
      ${input.scrutiny},
      ${input.reviewContext},
      ${input.requestedCount}
    )
    RETURNING ${SELECT_AUDIT_COLUMNS}
  `;
  return rows[0]!;
}

/** Record how many reviews the run actually enqueued, once fan-out is done. */
export async function setAuditEnqueuedCount(id: number, count: number): Promise<void> {
  await sql`UPDATE audit_runs SET enqueued_count = ${count} WHERE id = ${id}`;
}

export async function getAuditRun(userId: number, id: number): Promise<AuditRun | null> {
  const rows = await sql<AuditRun[]>`
    SELECT ${SELECT_AUDIT_COLUMNS}
    FROM audit_runs
    WHERE id = ${id} AND user_id = ${userId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listAuditRuns(userId: number, limit = 50): Promise<AuditRun[]> {
  return sql<AuditRun[]>`
    SELECT ${SELECT_AUDIT_COLUMNS}
    FROM audit_runs
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}
