import { config } from './config.ts';
import { sql } from './db.ts';
import {
  claimNext,
  markDone,
  markFailed,
  type PendingReview,
  type PostedEvent,
} from './db/reviews.ts';
import { fetchPullRequest, postPullRequestReview, type ReviewEvent } from './github/pulls.ts';
import { runReview, type Verdict } from './review/runner.ts';

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startWorker(): void {
  if (timer) return;
  const ms = config.workerIntervalSeconds * 1000;
  console.log(`[worker] starting, interval=${config.workerIntervalSeconds}s`);
  timer = setInterval(() => {
    void tick();
  }, ms);
}

export function stopWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const job = await claimNext();
    if (!job) return;
    console.log(
      `[worker] processing #${job.id} ${job.repoFull}#${job.prNumber} (scrutiny=${job.scrutiny}, auto_approve=${job.autoApprove})`,
    );
    await processJob(job);
  } catch (err) {
    console.error('[worker] tick error:', err);
  } finally {
    inFlight = false;
  }
}

async function processJob(job: PendingReview): Promise<void> {
  const userRow = await loadUser(job.userId);
  if (!userRow) {
    await markFailed(job.id, `User ${job.userId} not found or has no GitHub token`);
    return;
  }

  try {
    const { pr, diff } = await fetchPullRequest(userRow.token, job.repoFull, job.prNumber);
    const result = await runReview(
      {
        scrutiny: job.scrutiny,
        diff,
        prTitle: pr.title,
        prAuthor: pr.author,
        repoFull: pr.repoFull,
      },
      job.claudeMode,
    );

    const event = pickEvent({
      autoApprove: job.autoApprove,
      verdict: result.verdict,
      prAuthor: pr.author,
      reviewerLogin: userRow.login,
    });
    const stamped = stampReviewBody(result.body, job, result.verdict, event);
    await postPullRequestReview(userRow.token, job.repoFull, job.prNumber, stamped, event);
    await markDone(job.id, stamped, result.verdict, event);
    console.log(`[worker] done #${job.id} (verdict=${result.verdict}, event=${event})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(job.id, message);
    console.error(`[worker] failed #${job.id}: ${message}`);
  }
}

/**
 * Decide which GitHub review event to post.
 *
 * - Auto-approve is only honored when (a) the scope opted in, (b) the
 *   reviewer's verdict was `approve`, AND (c) the PR isn't authored by
 *   the same user posting the review (GitHub rejects self-approval).
 * - We deliberately do NOT auto-`REQUEST_CHANGES`. Auto-blocking a merge
 *   from a generated review is too aggressive for MVP; surfaces it as a
 *   comment with the verdict marker visible in the footer.
 */
function pickEvent(args: {
  autoApprove: boolean;
  verdict: Verdict;
  prAuthor: string;
  reviewerLogin: string;
}): ReviewEvent & PostedEvent {
  if (
    args.autoApprove &&
    args.verdict === 'approve' &&
    args.prAuthor.toLowerCase() !== args.reviewerLogin.toLowerCase()
  ) {
    return 'APPROVE';
  }
  return 'COMMENT';
}

async function loadUser(userId: number): Promise<{ token: string; login: string } | null> {
  const rows = await sql<{ token: string; login: string }[]>`
    SELECT github_token AS token, github_login AS login
    FROM users WHERE id = ${userId} LIMIT 1
  `;
  return rows[0] ?? null;
}

function stampReviewBody(
  body: string,
  job: PendingReview,
  verdict: Verdict,
  event: PostedEvent,
): string {
  const parts = [
    `scrutiny: \`${job.scrutiny}\``,
    `mode: \`${job.claudeMode}\``,
    `verdict: \`${verdict}\``,
    `posted as: \`${event}\``,
  ];
  return `${body}\n\n---\n_Reviewed by reviewme · ${parts.join(' · ')}_`;
}
