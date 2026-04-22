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
import { log } from "./log.ts";

export async function runTick(args: { gh: GH; cfg: Config; store: Store }): Promise<void> {
  const { gh, cfg, store } = args;

  const repos = await resolveWatchedRepos(gh, cfg);
  log.info("tick.repos", { count: repos.length });

  for (const repo of repos) {
    try {
      await processRepo(gh, cfg, store, repo);
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
}

async function processRepo(gh: GH, cfg: Config, store: Store, repo: RepoRef): Promise<void> {
  const prs = filterReviewable(await listOpenPulls(gh, repo), cfg);
  for (const pr of prs) {
    if (store.hasReviewed(slug(repo), pr.number, pr.head_sha)) continue;
    await processPr(gh, cfg, store, pr);
  }
}

async function processPr(gh: GH, cfg: Config, store: Store, pr: PullRef): Promise<void> {
  const repoSlug = slug(pr.repo);
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

  const approvals = store.approvalsInLastHour();
  if (approvals >= cfg.review.max_approvals_per_hour) {
    log.warn("ratelimit.block", { ...tag, approvals, cap: cfg.review.max_approvals_per_hour });
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
  const resolvedTone = resolveTone({
    cfg,
    owner: pr.repo.owner,
    name: pr.repo.name,
  });
  const prompt = buildReviewPrompt({
    pr: ctx,
    repo: repoSlug,
    pullNumber: pr.number,
    tone: resolvedTone,
  });

  log.info("claude.invoke", {
    ...tag,
    files: ctx.files.length,
    promptBytes: prompt.length,
    toneBytes: resolvedTone.length,
  });

  const result = await invokeClaude({
    command: cfg.claude.command,
    prompt,
    timeoutSeconds: cfg.claude.timeout_seconds,
  });

  if (!result.ok) {
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
    store.recordReview({
      repo: repoSlug,
      prNumber: pr.number,
      headSha: pr.head_sha,
      verdict: "skipped",
      note: `claude: ${result.error}`,
    });
    return;
  }

  const validated = validateReview(result.review, ctx);

  log.info("claude.ok", {
    ...tag,
    verdict: validated.verdict,
    validComments: validated.valid.length,
    droppedComments: validated.dropped.length,
  });

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
    store.recordReview({
      repo: repoSlug,
      prNumber: pr.number,
      headSha: pr.head_sha,
      verdict: "skipped",
      note: `post: ${post.error}`,
    });
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
    note: buildReviewNote(validated, resolvedTone),
  });

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
): string {
  const payload = {
    verdict: v.verdict,
    valid: v.valid,
    dropped: v.dropped,
    summary: v.summary,
    tone_used: toneUsed,
  };
  const json = JSON.stringify(payload);
  // Note is not size-constrained by sqlite; cap at 512KB to be safe.
  return json.slice(0, 512 * 1024);
}

function slug(r: RepoRef): string {
  return `${r.owner}/${r.name}`;
}
