import { config } from './config.ts';
import { sql } from './db.ts';
import {
  claimNext,
  deferReview,
  markDone,
  markFailed,
  markSkipped,
  markSkippedPendingPost,
  reapStuckReviews,
  requeueForRetry,
  setReviewPhase,
  type PendingReview,
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
} from './github/pulls.ts';
import { fetchChecksSummary, formatChecksSummary } from './github/checks.ts';
import {
  DiffTooLargeError,
  ReviewTimeoutError,
  runReview,
} from './review/runner.ts';
import { isTransientError, MAX_ATTEMPTS, retryDelaySeconds } from './retry.ts';
import { pickReviewEvent, statusForReview } from './review/gate.ts';
import { postCommitStatus } from './github/status.ts';
import { commentableLines, selectReviewComments } from './review/diffmap.ts';
import {
  buildSignalsNote,
  changedFilePaths,
  escalateScrutiny,
  testGapNote,
} from './review/signals.ts';
import {
  buildInjectionNote,
  scanForInjection,
  summarizeInjection,
} from './review/injection.ts';
import { createWorkerPool, type WorkerPool } from './worker-pool.ts';

let timer: ReturnType<typeof setInterval> | null = null;
let reaperTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;
let pool: WorkerPool | null = null;

// Stuck-review reaper. A healthy run is bounded by checkout (≤~6m) + the
// 5-minute review watchdog + posting, so 30m is comfortably past any live
// review and reaps a crashed-worker's orphaned row with zero false
// positives. Swept every 5m (cheap UPDATE) plus once shortly after boot so
// a restart clears its own debris promptly instead of after a full sweep.
const STUCK_AFTER_MINUTES = 30;
const STUCK_SWEEP_MS = 5 * 60_000;
const STUCK_BOOT_DELAY_MS = 10_000;

// Bounded deferral when CI hasn't finished yet. Two-minute interval × ten
// attempts = ~20 minutes total before we proceed regardless. CI that takes
// longer than 20 minutes shouldn't starve the review forever; the prompt
// will note any still-pending checks under non-blocking.
const DEFER_INTERVAL_SECONDS = 120;
const MAX_DEFERS = 10;

export function startWorker(): void {
  if (timer) return;
  const ms = config.workerIntervalSeconds * 1000;
  pool = createWorkerPool<PendingReview>({
    concurrency: config.workerConcurrency,
    claim: claimNext,
    run: runJob,
    onClaimError: (err) => console.error('[worker] claim error:', err),
    // A job that throws past processJob's own handling is already logged
    // there; this is the last-resort net so the pool always re-pumps.
    onRunError: (err) => console.error('[worker] job error:', err),
  });
  console.log(
    `[worker] starting, interval=${config.workerIntervalSeconds}s, ` +
      `concurrency=${pool.concurrency}`,
  );
  // The timer is the safety net: it re-pumps so a deferred review whose
  // window elapsed (no NOTIFY fires for that) is still picked up. When all
  // slots are busy a pump is a cheap synchronous no-op.
  timer = setInterval(() => {
    pool?.pump();
  }, ms);

  // Wake immediately when a review is newly enqueued. NOTIFY-driven; no
  // extra polling. The pool tops up only idle slots, so a pump during a
  // long-running review is harmless and the new row is claimed the moment
  // a slot frees (each finished job re-pumps).
  unsubscribe = subscribeAll((event) => {
    if (event.status !== 'queued') return;
    pool?.pump();
  });

  // Reap rows orphaned in `running` by a dead/restarted worker. Runs soon
  // after boot (clear our own debris) and then on a slow interval.
  setTimeout(() => { void sweepStuck(); }, STUCK_BOOT_DELAY_MS);
  reaperTimer = setInterval(() => { void sweepStuck(); }, STUCK_SWEEP_MS);
}

export function stopWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  // In-flight jobs are not aborted (same as before — shutdown calls
  // process.exit); dropping the ref just stops new pumps from the timer.
  pool = null;
}

export type WorkerStatus = { concurrency: number; active: number };

export function getWorkerStatus(): WorkerStatus {
  return {
    concurrency: pool ? pool.concurrency : config.workerConcurrency,
    active: pool ? pool.active : 0,
  };
}

async function sweepStuck(): Promise<void> {
  try {
    const reaped = await reapStuckReviews(STUCK_AFTER_MINUTES);
    if (reaped.length > 0) {
      console.error(
        `[worker] reaped ${reaped.length} stuck review(s) ` +
          `(running > ${STUCK_AFTER_MINUTES}m): ` +
          reaped.map((r) => `#${r.id} ${r.repoFull}#${r.prNumber}`).join(', '),
      );
    }
  } catch (err) {
    console.error('[worker] stuck sweep error:', err);
  }
}

// One claimed job: log it, then hand off to the full review pipeline.
// processJob handles its own failures (it marks the row failed/skipped and
// never rethrows in the normal path); anything that still escapes is caught
// by the pool's onRunError net, which logs and frees the slot.
async function runJob(job: PendingReview): Promise<void> {
  console.log(
    `[worker] processing #${job.id} ${job.repoFull}#${job.prNumber} (scrutiny=${job.scrutiny}, auto_approve=${job.autoApprove})`,
  );
  await processJob(job);
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

    // Changed-file signals: escalate scrutiny for sensitive paths and note
    // a missing-tests gap. Advisory — escalation only ever raises rigor by
    // one tier; the note is just guidance. Effective tier (not the scope's
    // snapshot) drives both the prompt and the footer so the posted review
    // honestly reflects what ran.
    const changedPaths = changedFilePaths(diff);
    const escalation = escalateScrutiny(job.scrutiny, changedPaths);
    const effectiveScrutiny = escalation ? escalation.scrutiny : job.scrutiny;
    const signalsNote = buildSignalsNote(escalation, testGapNote(changedPaths));
    if (escalation) {
      console.log(
        `[worker] #${job.id} scrutiny ${job.scrutiny}→${effectiveScrutiny} ` +
          `(sensitive: ${escalation.hits.join(', ')})`,
      );
    }

    // Prompt-injection scan over the untrusted PR inputs. Advisory: it
    // hardens the prompt + warns the operator, never blocks/re-verdicts
    // the review (the model is told to use judgment — benign occurrences
    // exist, e.g. a PR that is itself about prompt injection).
    const injection = scanForInjection([
      { label: 'PR title', text: pr.title },
      { label: 'PR author', text: pr.author },
      { label: 'diff', text: diff },
    ]);
    const injectionNote = buildInjectionNote(injection);
    if (injectionNote) {
      console.warn(
        `[worker] #${job.id} possible prompt-injection ` +
          `(${injection.hits.length} hit(s)): ${summarizeInjection(injection)}`,
      );
    }

    const result = await runReview(
      {
        scrutiny: effectiveScrutiny,
        diff,
        prTitle: pr.title,
        prAuthor: pr.author,
        repoFull: pr.repoFull,
        personalityPrompt: job.personalityPrompt,
        ciSummary,
        diffNotice,
        signalsNote,
        injectionNote,
        reviewContext: job.reviewContext,
        checkout: {
          token: userRow.token,
          prNumber: job.prNumber,
          headSha: pr.headSha,
        },
      },
      job.claudeMode,
    );

    const event = pickReviewEvent({
      autoApprove: job.autoApprove,
      gateOnBlocking: job.gateOnBlocking,
      verdict: result.verdict,
      findings: result.findings ?? null,
      prAuthor: pr.author,
      reviewerLogin: userRow.login,
    });
    const stamped = stampReviewBody(result.body, job.footerTemplate, {
      scrutiny: effectiveScrutiny,
      mode: job.claudeMode,
      verdict: result.verdict,
      postedEvent: event,
    });
    // Inline comments: keep only model findings that anchor to a real
    // line in this diff (GitHub 422s the whole review otherwise). The rest
    // remain in the summary body the model already wrote.
    const { comments: inlineComments, dropped } = selectReviewComments(
      result.items ?? [],
      commentableLines(diff),
    );
    if (inlineComments.length > 0 || dropped > 0) {
      console.log(
        `[worker] #${job.id} inline comments: ${inlineComments.length} anchored` +
          `${dropped > 0 ? `, ${dropped} unmapped (kept in summary)` : ''}`,
      );
    }

    await setReviewPhase(job.id, 'posting');
    try {
      await postPullRequestReview(
        userRow.token,
        job.repoFull,
        job.prNumber,
        stamped,
        event,
        inlineComments,
      );
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
        await markSkippedPendingPost(
          job.id,
          reason,
          stamped,
          result.verdict,
          event,
          result.costUsd ?? null,
          result.findings ?? null,
        );
        console.log(
          `[worker] skipped #${job.id} (locked conversation; body preserved for post-anyway)`,
        );
        return;
      }
      throw postErr;
    }

    // Opt-in soft merge gate: a commit status mirroring the verdict. Make
    // it a required check in branch protection for an actual gate.
    // Best-effort — a flaky status call must never fail a posted review.
    if (job.gateOnBlocking) {
      const s = statusForReview({
        verdict: result.verdict,
        findings: result.findings ?? null,
      });
      try {
        await postCommitStatus(userRow.token, job.repoFull, pr.headSha, {
          state: s.state,
          context: 'arbiter/review',
          description: s.description,
          targetUrl: `${config.publicUrl}/queue/${job.id}`,
        });
      } catch (statusErr) {
        console.error(
          `[worker] commit status for #${job.id} failed (non-fatal): ` +
            `${statusErr instanceof Error ? statusErr.message : String(statusErr)}`,
        );
      }
    }

    await markDone(
      job.id,
      stamped,
      result.verdict,
      event,
      result.costUsd ?? null,
      result.findings ?? null,
    );
    console.log(
      `[worker] done #${job.id} (verdict=${result.verdict}, event=${event}` +
        `${result.costUsd != null ? `, cost=$${result.costUsd}` : ''})`,
    );
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
    // Transient infra failures (GitHub 5xx / rate limit, network resets)
    // shouldn't need a human: auto-requeue with exponential backoff until
    // `attempt` hits MAX_ATTEMPTS. ReviewTimeoutError is excluded on
    // purpose — re-running a 5-minute model hang burns wall time and quota,
    // so that stays a manual retry.
    if (
      !(err instanceof ReviewTimeoutError) &&
      isTransientError(err) &&
      job.attempt < MAX_ATTEMPTS
    ) {
      const delay = retryDelaySeconds(job.attempt);
      const requeued = await requeueForRetry(job.id, delay, message);
      if (requeued) {
        console.warn(
          `[worker] transient failure on #${job.id} ` +
            `(attempt ${job.attempt}/${MAX_ATTEMPTS}); auto-retry in ${delay}s: ${message}`,
        );
        return;
      }
      // requeue no-op (row no longer running, e.g. reaped) — fall through
      // to the normal failure path rather than silently dropping it.
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

async function loadUser(userId: number): Promise<{ token: string; login: string } | null> {
  const rows = await sql<{ token: string; login: string }[]>`
    SELECT github_token AS token, github_login AS login
    FROM users WHERE id = ${userId} LIMIT 1
  `;
  return rows[0] ?? null;
}

