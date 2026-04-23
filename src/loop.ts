import type { Config } from "./config.ts";
import type { GH } from "./github/client.ts";
import type { Store } from "./state/db.ts";
import type { PullRef, RepoRef } from "./github/discover.ts";
import { filterReviewable, listOpenPulls, resolveWatchedRepos } from "./github/discover.ts";
import { evaluateCi } from "./github/ci.ts";
import { fetchPrContext } from "./github/diff.ts";
import { buildReviewPrompt } from "./claude/prompt.ts";
import { invokeClaude } from "./claude/invoke.ts";
import { validateReview } from "./review/validate.ts";
import { postReview } from "./review/post.ts";
import { resolveTone } from "./review/tone.ts";
import { filterFiles } from "./review/file-filter.ts";
import type { Breaker } from "./review/breaker.ts";
import { resolveIntent } from "./intent/resolve.ts";
import type { TicketContext } from "./intent/types.ts";
import { log } from "./log.ts";
import type { ActivePr, Runtime } from "./web/runtime.ts";

/**
 * Progress-reporting slice of Runtime that the loop needs. Taking only these
 * fields keeps runTick testable without pulling in every unrelated runtime field.
 */
type Progress = Pick<Runtime, "currentPrs" | "lastActivityAt">;

export async function runTick(args: {
  gh: GH;
  cfg: Config;
  store: Store;
  progress: Progress;
  breaker: Breaker;
}): Promise<void> {
  const { gh, cfg, store, progress, breaker } = args;

  // Phase 1: resolve the eligible-PR list across every watched repo. Errors
  // listing one repo don't stop the others.
  const repos = await resolveWatchedRepos(gh, cfg);
  log.info("tick.repos", { count: repos.length });

  const eligible: PullRef[] = [];
  const deadLetterThreshold = cfg.review.dead_letter_threshold;
  for (const repo of repos) {
    try {
      const prs = filterReviewable(await listOpenPulls(gh, repo), cfg);
      for (const pr of prs) {
        const s = slug(repo);
        if (store.hasReviewed(s, pr.number, pr.head_sha)) continue;
        // Dead-letter gate: PRs at/above threshold are skipped until the
        // operator Retries or Dismisses via the UI.
        if (deadLetterThreshold > 0) {
          const f = store.getFailure(s, pr.number, pr.head_sha);
          if (f && f.failure_count >= deadLetterThreshold) continue;
        }
        eligible.push(pr);
      }
    } catch (e) {
      const msg = (e as Error).message;
      log.error("repo.failed", { repo: slug(repo), error: msg });
      store.recordEvent({
        level: "error",
        kind: "repo.failed",
        message: msg,
        repo: slug(repo),
      });
    }
  }

  if (eligible.length === 0) return;

  // Phase 2: fan out N workers pulling from a shared queue. Array.shift() is
  // synchronous and JS is single-threaded, so there's no race between worker
  // microtasks picking items off the front.
  const concurrency = Math.max(1, Math.min(4, cfg.review.concurrency));
  log.info("tick.fanout", { prs: eligible.length, concurrency });

  const queue = [...eligible];
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const pr = queue.shift();
      if (!pr) return;
      try {
        await processPr(gh, cfg, store, pr, progress, breaker);
      } catch (e) {
        // processPr catches its own errors and records events, but if
        // anything leaks out we log and keep the worker alive to drain the
        // queue.
        log.error("pr.unhandled", {
          repo: slug(pr.repo),
          pr: pr.number,
          error: (e as Error).message,
        });
      }
    }
  });
  await Promise.all(workers);
}

async function processPr(
  gh: GH,
  cfg: Config,
  store: Store,
  pr: PullRef,
  progress: Progress,
  breaker: Breaker,
): Promise<void> {
  const repoSlug = slug(pr.repo);
  const active: ActivePr = {
    repo: repoSlug,
    number: pr.number,
    startedAt: new Date().toISOString(),
  };
  progress.currentPrs.push(active);
  try {
    await processPrInner(gh, cfg, store, pr, repoSlug, breaker);
  } finally {
    const i = progress.currentPrs.indexOf(active);
    if (i >= 0) progress.currentPrs.splice(i, 1);
    progress.lastActivityAt = new Date().toISOString();
  }
}

async function processPrInner(
  gh: GH,
  cfg: Config,
  store: Store,
  pr: PullRef,
  repoSlug: string,
  breaker: Breaker,
): Promise<void> {
  const tag = { repo: repoSlug, pr: pr.number, sha: pr.head_sha.slice(0, 7) };

  if (cfg.review.require_ci_green) {
    const ci = await evaluateCi(gh, pr.repo, pr.head_sha);
    if (ci.kind === "pending") {
      log.info("ci.pending", { ...tag, pending: ci.pending });
      return;
    }
    if (ci.kind === "failing") {
      log.info("ci.failing", { ...tag, failing: ci.failing });
      store.recordEvent({
        level: "info",
        kind: "ci.failing",
        message: `CI failing: ${ci.failing.join(", ")}`,
        repo: repoSlug,
        prNumber: pr.number,
        headSha: pr.head_sha,
        payload: { failing: ci.failing },
      });
      return;
    }
    if (ci.kind === "none") {
      log.info("ci.none", tag);
      return;
    }
  }

  // Pre-Claude approval cap check (cheap; avoids wasting a Claude invocation
  // when we clearly can't post). With concurrency > 1 this is a best-effort
  // guard — a second check runs after Claude returns, before we record the
  // approval, to close the obvious race.
  const approvalsBefore = store.approvalsInLastHour();
  if (approvalsBefore >= cfg.review.max_approvals_per_hour) {
    log.warn("ratelimit.block", {
      ...tag,
      approvals: approvalsBefore,
      cap: cfg.review.max_approvals_per_hour,
    });
    store.recordEvent({
      level: "warn",
      kind: "ratelimit.block",
      message: `Approval cap (${cfg.review.max_approvals_per_hour}/hr) reached; deferring`,
      repo: repoSlug,
      prNumber: pr.number,
      headSha: pr.head_sha,
    });
    return;
  }

  const ctx = await fetchPrContext(gh, pr.repo, pr.number);

  // Drop files that match the configured include/exclude globs BEFORE
  // building the prompt. Keeps Claude focused on meaningful diffs and stops
  // us from paying to review 2MB lockfiles. ctx.files is mutated to the
  // filtered list so downstream line-comment validation only considers
  // files Claude actually saw.
  const originalFileCount = ctx.files.length;
  const filtered = filterFiles(
    ctx.files,
    cfg.review.include_paths,
    cfg.review.exclude_paths,
  );
  ctx.files = filtered.kept;

  if (ctx.files.length === 0) {
    log.info("files.all_filtered", { ...tag, originalFileCount });
    store.recordEvent({
      level: "info",
      kind: "files.all_filtered",
      message: `All ${originalFileCount} file(s) filtered out by include/exclude globs; no review performed.`,
      repo: repoSlug,
      prNumber: pr.number,
      headSha: pr.head_sha,
      payload: {
        skipped: filtered.skipped.slice(0, 50).map((s) => ({
          path: s.file.path,
          reason: s.reason,
          pattern: s.pattern,
        })),
      },
    });
    store.recordReview({
      repo: repoSlug,
      prNumber: pr.number,
      headSha: pr.head_sha,
      verdict: "skipped",
      note: `All ${originalFileCount} files matched exclude globs; nothing to review.`,
    });
    return;
  }

  const resolvedTone = resolveTone({
    cfg,
    owner: pr.repo.owner,
    name: pr.repo.name,
  });

  // Pull intent context (linked GitHub issues/PRs) from the title+body so the
  // prompt grounds review against what the ticket asked for, not just
  // "does the code look OK." A resolution failure just means the review
  // proceeds without that ticket — never aborts.
  let intent: { tickets: TicketContext[] } = { tickets: [] };
  try {
    const resolved = await resolveIntent({
      gh,
      store,
      title: ctx.title,
      body: ctx.body,
      ownRepo: pr.repo,
    });
    intent = { tickets: resolved.tickets };
    if (resolved.misses.length > 0 || resolved.dropped.length > 0) {
      store.recordEvent({
        level: "info",
        kind: "intent.partial",
        message: `intent resolution partial: ${resolved.tickets.length} fetched, ${resolved.misses.length} missed, ${resolved.dropped.length} dropped (max refs)`,
        repo: repoSlug,
        prNumber: pr.number,
        headSha: pr.head_sha,
        payload: {
          missedKeys: resolved.misses.map((r) => r.key),
          droppedKeys: resolved.dropped.map((r) => r.key),
        },
      });
    }
  } catch (e) {
    log.warn("intent.failed", { ...tag, error: (e as Error).message });
    store.recordEvent({
      level: "warn",
      kind: "intent.failed",
      message: `intent resolution failed: ${(e as Error).message}`,
      repo: repoSlug,
      prNumber: pr.number,
      headSha: pr.head_sha,
    });
  }

  const prompt = buildReviewPrompt({
    pr: ctx,
    repo: repoSlug,
    pullNumber: pr.number,
    tone: resolvedTone,
    tickets: intent.tickets,
  });

  // Breaker gate: if Claude has failed enough times in a row the breaker is
  // open; skip the call entirely. DO NOT record a review row — dedupe stays
  // empty so the next tick (after the breaker closes) picks this PR up fresh.
  const acquire = breaker.tryAcquire();
  if (!acquire.allowed) {
    const msRemaining = acquire.reopensAt - Date.now();
    log.warn("breaker.deferred", { ...tag, reopensAt: acquire.reopensAt });
    store.recordEvent({
      level: "warn",
      kind: "breaker.deferred",
      message: `Claude breaker is open; deferring (reopens in ${Math.max(0, Math.ceil(msRemaining / 1000))}s). Last reason: ${acquire.lastReason}`,
      repo: repoSlug,
      prNumber: pr.number,
      headSha: pr.head_sha,
      payload: { reopensAt: new Date(acquire.reopensAt).toISOString(), lastReason: acquire.lastReason },
    });
    return;
  }

  log.info("claude.invoke", {
    ...tag,
    files: ctx.files.length,
    filesFilteredOut: filtered.skipped.length,
    promptBytes: prompt.length,
    toneBytes: resolvedTone.length,
    breakerTrial: acquire.trial,
  });

  const result = await invokeClaude({
    command: cfg.claude.command,
    prompt,
    timeoutSeconds: cfg.claude.timeout_seconds,
  });

  if (!result.ok) {
    breaker.recordFailure(result.error);
    log.error("claude.failed", { ...tag, error: result.error, stderr: result.stderr });
    store.recordEvent({
      level: "error",
      kind: "claude.failed",
      message: result.error,
      repo: repoSlug,
      prNumber: pr.number,
      headSha: pr.head_sha,
      payload: {
        stderr: result.stderr?.slice(0, 2000),
        stdoutSample: result.stdoutSample?.slice(0, 500),
      },
    });
    // Bump the per-PR failure counter. At or above dead_letter_threshold the
    // discovery filter stops picking this PR up until the operator retries or
    // dismisses from the Dashboard. No recordReview here — dedupe should only
    // hold successful reviews.
    const count = store.recordFailure({
      repo: repoSlug,
      prNumber: pr.number,
      headSha: pr.head_sha,
      kind: "claude",
      error: result.error,
    });
    if (count >= cfg.review.dead_letter_threshold && cfg.review.dead_letter_threshold > 0) {
      store.recordEvent({
        level: "warn",
        kind: "dead_letter.entered",
        message: `PR dead-lettered after ${count} failures; needs operator attention`,
        repo: repoSlug,
        prNumber: pr.number,
        headSha: pr.head_sha,
        payload: { count, threshold: cfg.review.dead_letter_threshold },
      });
    }
    return;
  }
  breaker.recordSuccess();

  const validated = validateReview(result.review, ctx);

  log.info("claude.ok", {
    ...tag,
    verdict: validated.verdict,
    validComments: validated.valid.length,
    droppedComments: validated.dropped.length,
  });

  // Second cap check. Between the pre-check and now another worker may have
  // posted an approval that brought us to the cap. This is cheap compared to
  // the Claude call we just made; run it only when the verdict would spend a
  // slot AND we're not in dry-run (dry-run never posts, so never consumes
  // quota).
  if (!cfg.review.dry_run && validated.verdict === "approve") {
    const approvalsAfter = store.approvalsInLastHour();
    if (approvalsAfter >= cfg.review.max_approvals_per_hour) {
      log.warn("ratelimit.block_post", {
        ...tag,
        approvals: approvalsAfter,
        cap: cfg.review.max_approvals_per_hour,
      });
      store.recordEvent({
        level: "warn",
        kind: "ratelimit.block",
        message: `Approval cap reached between Claude call and post; deferring this PR to next tick`,
        repo: repoSlug,
        prNumber: pr.number,
        headSha: pr.head_sha,
      });
      // NOTE: we intentionally do not recordReview here, so dedupe stays
      // empty and the next tick re-reviews this SHA. Losing the Claude
      // output is the trade for staying under the cap.
      return;
    }
  }

  const post = await postReview({
    gh,
    repo: pr.repo,
    pullNumber: pr.number,
    headSha: pr.head_sha,
    review: validated,
    dryRun: cfg.review.dry_run,
  });

  if (!post.ok) {
    log.error("post.failed", { ...tag, error: post.error });
    store.recordEvent({
      level: "error",
      kind: "post.failed",
      message: post.error,
      repo: repoSlug,
      prNumber: pr.number,
      headSha: pr.head_sha,
    });
    const count = store.recordFailure({
      repo: repoSlug,
      prNumber: pr.number,
      headSha: pr.head_sha,
      kind: "post",
      error: post.error,
    });
    if (count >= cfg.review.dead_letter_threshold && cfg.review.dead_letter_threshold > 0) {
      store.recordEvent({
        level: "warn",
        kind: "dead_letter.entered",
        message: `PR dead-lettered after ${count} failures; needs operator attention`,
        repo: repoSlug,
        prNumber: pr.number,
        headSha: pr.head_sha,
        payload: { count, threshold: cfg.review.dead_letter_threshold },
      });
    }
    return;
  }

  const persisted =
    cfg.review.dry_run
      ? "dry_run"
      : validated.verdict === "approve"
        ? "approve"
        : "request_changes";

  store.recordReview({
    repo: repoSlug,
    prNumber: pr.number,
    headSha: pr.head_sha,
    verdict: persisted,
    note: buildReviewNote(validated, resolvedTone, intent.tickets),
  });
  // Any prior failure counter for this SHA is now stale — a successful review
  // means we've recovered.
  store.clearFailure(repoSlug, pr.number, pr.head_sha);

  store.recordEvent({
    level: "info",
    kind: cfg.review.dry_run ? "post.dry_run" : "post.ok",
    message: cfg.review.dry_run
      ? `dry-run: would ${validated.verdict}`
      : `posted ${validated.verdict}`,
    repo: repoSlug,
    prNumber: pr.number,
    headSha: pr.head_sha,
    payload: {
      url: "url" in post ? post.url : undefined,
      validComments: validated.valid.length,
      droppedComments: validated.dropped.length,
    },
  });

  log.info("post.ok", {
    ...tag,
    dryRun: cfg.review.dry_run,
    verdict: validated.verdict,
    url: "url" in post ? post.url : undefined,
  });
}

function buildReviewNote(
  v: {
    summary: string;
    valid: unknown[];
    dropped: unknown[];
    verdict: string;
  },
  toneUsed: string,
  tickets: TicketContext[],
): string {
  const payload = {
    verdict: v.verdict,
    valid: v.valid,
    dropped: v.dropped,
    summary: v.summary,
    tone_used: toneUsed,
    // Stripped down — the review detail page wants the reference + title +
    // url, but the full body is already in the event timeline.
    tickets: tickets.map((t) => ({
      kind: t.kind,
      key: t.key,
      title: t.title,
      url: t.url,
      isPullRequest: t.isPullRequest ?? false,
    })),
  };
  const json = JSON.stringify(payload);
  return json.slice(0, 512 * 1024);
}

function slug(r: RepoRef): string {
  return `${r.owner}/${r.name}`;
}
