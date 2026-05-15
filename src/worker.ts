import { config } from './config.ts';
import { sql } from './db.ts';
import {
  claimNext,
  deferReview,
  markDone,
  markFailed,
  markSkipped,
  markSkippedPendingPost,
  setReviewPhase,
  type PendingReview,
  type PostedEvent,
} from './db/reviews.ts';
import { markTokenRevoked } from './db/users.ts';
import { subscribeAll } from './events.ts';
import { describeError } from './errors.ts';
import { stampReviewBody } from './review/footer.ts';
import {
  DiffTooManyFilesError,
  fetchPullRequest,
  isLockedConversationError,
  postPullRequestReview,
  type ReviewEvent,
} from './github/pulls.ts';
import { fetchChecksSummary, formatChecksSummary } from './github/checks.ts';
import { DiffTooLargeError, runReview, type Verdict } from './review/runner.ts';

let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let inFlight = false;
// Set when an event fires while a job is in flight, so we don't miss work
// queued during a long-running review. Drained when the in-flight job ends.
let pendingWake = false;

// Bounded deferral when CI hasn't finished yet. Two-minute interval × ten
// attempts = ~20 minutes total before we proceed regardless. CI that takes
// longer than 20 minutes shouldn't starve the review forever; the prompt
// will note any still-pending checks under non-blocking.
const DEFER_INTERVAL_SECONDS = 120;
const MAX_DEFERS = 10;

export function startWorker(): void {
  if (timer) return;
  const ms = config.workerIntervalSeconds * 1000;
  console.log(`[worker] starting, interval=${config.workerIntervalSeconds}s`);
  timer = setInterval(() => {
    void tick();
  }, ms);

  // Wake immediately when a review is newly enqueued. NOTIFY-driven; no
  // extra polling. While a tick is in-flight, the inFlight guard turns
  // this into a no-op, but the timer + pendingWake flag together ensure
  // the newly-queued review is picked up as soon as the worker is free.
  unsubscribe = subscribeAll((event) => {
    if (event.status !== 'queued') return;
    if (inFlight) {
      pendingWake = true;
      return;
    }
    void tick();
  });
}

export function stopWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

async function tick(): Promise<void> {
  if (inFlight) {
    pendingWake = true;
    return;
  }
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
    // If events arrived while we were busy, drain immediately rather than
    // waiting for the next 5s timer tick.
    if (pendingWake) {
      pendingWake = false;
      // setImmediate-equivalent: yield to the event loop before recursing so
      // we don't blow the stack on a backlog.
      queueMicrotask(() => {
        void tick();
      });
    }
  }
}

async function processJob(job: PendingReview): Promise<void> {
  const userRow = await loadUser(job.userId);
  if (!userRow) {
    await markFailed(job.id, `User ${job.userId} not found or has no GitHub token`);
    return;
  }

  try {
    const { pr, diff, diffNotice } = await fetchPullRequest(
      userRow.token,
      job.repoFull,
      job.prNumber,
    );
    // Fetch CI signals in parallel with prep work would be ideal, but the
    // diff fetch already dominates wall time. Sequential keeps the code
    // simple; fetchChecksSummary swallows its own errors so we'll never
    // fail the review just because the checks API hiccupped.
    const checks = await fetchChecksSummary(userRow.token, job.repoFull, pr.headSha);

    // If at least one check is still pending and none have failed yet,
    // hold the review for a couple of minutes — we'd rather wait for the
    // full picture than land "CI was still running, FYI" reviews. After
    // MAX_DEFERS attempts (~20 min total) we proceed anyway so a stuck or
    // hours-long pipeline doesn't starve the review forever.
    if (
      checks.hasPending &&
      !checks.anyFailing &&
      job.deferCount < MAX_DEFERS
    ) {
      await deferReview(job.id, DEFER_INTERVAL_SECONDS);
      console.log(
        `[worker] deferring #${job.id} (${job.repoFull}#${job.prNumber}) — CI pending, defer ${job.deferCount + 1}/${MAX_DEFERS}`,
      );
      return;
    }

    // preparing (set by claimNext) → reviewing: the multi-minute claude
    // call. This is the phase the queue UI dwells on; emit it explicitly.
    await setReviewPhase(job.id, 'reviewing');
    const ciSummary = formatChecksSummary(checks);
    const result = await runReview(
      {
        scrutiny: job.scrutiny,
        diff,
        prTitle: pr.title,
        prAuthor: pr.author,
        repoFull: pr.repoFull,
        personalityPrompt: job.personalityPrompt,
        ciSummary,
        diffNotice,
      },
      job.claudeMode,
    );

    const event = pickEvent({
      autoApprove: job.autoApprove,
      verdict: result.verdict,
      prAuthor: pr.author,
      reviewerLogin: userRow.login,
    });
    const stamped = stampReviewBody(result.body, job.footerTemplate, {
      scrutiny: job.scrutiny,
      mode: job.claudeMode,
      verdict: result.verdict,
      postedEvent: event,
    });
    await setReviewPhase(job.id, 'posting');
    try {
      await postPullRequestReview(userRow.token, job.repoFull, job.prNumber, stamped, event);
    } catch (postErr) {
      // The review is generated and valid — only the POST failed because
      // the PR conversation is locked. A retry would just re-lock, so
      // don't fail: skip but PRESERVE the body so the user can
      // "Post anyway" after unlocking. Any other post error falls
      // through to the generic handler below.
      if (isLockedConversationError(postErr)) {
        const reason =
          'PR conversation is locked — review generated but not posted. ' +
          'Use "Post anyway" once the conversation is unlocked on GitHub.';
        await markSkippedPendingPost(job.id, reason, stamped, result.verdict, event);
        console.log(
          `[worker] skipped #${job.id} (locked conversation; body preserved for post-anyway)`,
        );
        return;
      }
      throw postErr;
    }
    await markDone(job.id, stamped, result.verdict, event);
    console.log(`[worker] done #${job.id} (verdict=${result.verdict}, event=${event})`);
  } catch (err) {
    const message = describeError(err);
    // Structural limits (PR too big, diff over our size cap) — not failures
    // worth retrying. Mark skipped so the queue UI doesn't offer a retry
    // button; the row stays in the timeline as a record of "we saw it,
    // can't review it."
    if (err instanceof DiffTooManyFilesError || err instanceof DiffTooLargeError) {
      await markSkipped(job.id, message);
      console.log(`[worker] skipped #${job.id}: ${message}`);
      return;
    }
    // Detect a revoked OAuth token: Octokit RequestError surfaces a
    // `status` of 401 when GitHub rejects the token. Mark the user so the
    // top-nav banner can prompt re-auth; otherwise the worker will keep
    // 401ing on every queued job for this user.
    if (isUnauthorized(err)) {
      await markTokenRevoked(job.userId);
      console.error(`[worker] user ${job.userId} GitHub token revoked — banner will prompt re-auth`);
    }
    await markFailed(job.id, message);
    console.error(`[worker] failed #${job.id}: ${message}`);
  }
}

function isUnauthorized(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: unknown }).status;
  return status === 401;
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

