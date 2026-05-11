import { config } from './config.ts';
import { sql } from './db.ts';
import { claimNext, markDone, markFailed, type PendingReview } from './db/reviews.ts';
import { fetchPullRequest, postPullRequestReview } from './github/pulls.ts';
import { runReview } from './review/runner.ts';

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

/**
 * One worker tick: claim the next queued review (if any), run it, post
 * the result to GitHub, and mark done/failed.
 *
 * Concurrency notes:
 * - `inFlight` prevents overlapping ticks in this process. Reviews can
 *   take 30+ seconds; the timer would otherwise queue more ticks.
 * - `claimNext` uses FOR UPDATE SKIP LOCKED so cross-process workers
 *   (or restarts during a stuck job) won't double-process the same row.
 */
async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const job = await claimNext();
    if (!job) return;
    console.log(
      `[worker] processing #${job.id} ${job.repoFull}#${job.prNumber} (scrutiny=${job.scrutiny})`,
    );
    await processJob(job);
  } catch (err) {
    // Only fires if claimNext itself fails — processJob handles its own errors.
    console.error('[worker] tick error:', err);
  } finally {
    inFlight = false;
  }
}

async function processJob(job: PendingReview): Promise<void> {
  const token = await loadGithubToken(job.userId);
  if (!token) {
    await markFailed(job.id, `User ${job.userId} not found or has no GitHub token`);
    return;
  }

  try {
    const { pr, diff } = await fetchPullRequest(token, job.repoFull, job.prNumber);
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

    const stamped = stampReviewBody(result.body, job);
    await postPullRequestReview(token, job.repoFull, job.prNumber, stamped);
    await markDone(job.id, stamped);
    console.log(`[worker] done #${job.id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(job.id, message);
    console.error(`[worker] failed #${job.id}: ${message}`);
  }
}

async function loadGithubToken(userId: number): Promise<string | null> {
  const rows = await sql<{ token: string }[]>`
    SELECT github_token AS token FROM users WHERE id = ${userId} LIMIT 1
  `;
  return rows[0]?.token ?? null;
}

/**
 * Append a small footer so reviewers know which scrutiny tier and Claude
 * mode produced the review. Helps when tuning prompts later.
 */
function stampReviewBody(body: string, job: PendingReview): string {
  return `${body}\n\n---\n_Reviewed by reviewme · scrutiny: \`${job.scrutiny}\` · mode: \`${job.claudeMode}\`_`;
}
