// Time Machine — retro-audit orchestration. One entry point that turns
// "audit the last N merged PRs in this repo" into an audit_runs row plus a
// fan-out of report-only reviews the existing worker pool drains. Mirrors
// enqueue.ts's role as the single decision point, so the report-only
// contract lives in exactly one place.

import { config } from './config.ts';
import { createAuditRun, setAuditEnqueuedCount, type AuditRun } from './db/audits.ts';
import { enqueueReview } from './db/reviews.ts';
import { listRecentMergedPulls } from './github/pulls.ts';
import type { ReviewContext, Scrutiny } from './db/scopes.ts';

export type EnqueueAuditResult = {
  run: AuditRun;
  /** How many merged PRs were found + enqueued as report-only reviews. */
  enqueued: number;
};

/**
 * Create an audit run and enqueue one report-only review per recent merged
 * PR. Report-only means the worker generates + persists each review but
 * posts NOTHING to GitHub (worker.ts honors job.reportOnly), so a noisy
 * first run has zero blast radius and never 422s on a closed PR.
 *
 * Reviews are enqueued with trigger 'manual' so they're exempt from the
 * (repo, pr, head_sha) idempotency index — re-auditing the same repo is a
 * fresh run, not a silent no-op — and with auto-approve / gate-on-blocking
 * off (moot for report-only, but explicit so nothing can leak a GitHub
 * side effect). Built-in defaults for footer / personality / skill: an
 * audit isn't tied to a scope.
 */
export async function enqueueAudit(input: {
  userId: number;
  githubToken: string;
  repoFull: string;
  limit: number;
  scrutiny: Scrutiny;
  reviewContext: ReviewContext;
}): Promise<EnqueueAuditResult> {
  const run = await createAuditRun({
    userId: input.userId,
    repoFull: input.repoFull,
    scrutiny: input.scrutiny,
    reviewContext: input.reviewContext,
    requestedCount: input.limit,
  });

  const merged = await listRecentMergedPulls(
    input.githubToken,
    input.repoFull,
    input.limit,
  );

  let enqueued = 0;
  for (const pr of merged) {
    const row = await enqueueReview({
      userId: input.userId,
      repoFull: pr.repoFull,
      prNumber: pr.number,
      prTitle: pr.title,
      prAuthor: pr.author,
      baseBranch: pr.baseBranch,
      headBranch: pr.headBranch,
      headSha: pr.headSha,
      scrutiny: input.scrutiny,
      claudeMode: config.claude.defaultMode,
      autoApprove: false,
      gateOnBlocking: false,
      footerTemplate: null,
      personalityPrompt: null,
      humanize: false,
      reviewerSkill: null,
      reviewContext: input.reviewContext,
      trigger: 'manual',
      reportOnly: true,
      auditRunId: run.id,
    });
    if (row) enqueued++;
  }

  await setAuditEnqueuedCount(run.id, enqueued);
  return { run, enqueued };
}
