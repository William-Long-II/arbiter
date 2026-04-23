import type { Config } from "../config.ts";
import type { GH } from "../github/client.ts";
import type { RepoRef } from "../github/discover.ts";
import type { Store } from "../state/db.ts";
import type { Breaker } from "../review/breaker.ts";
import { fetchPrContext } from "../github/diff.ts";
import { resolveTone } from "../review/tone.ts";
import { buildReplyPrompt } from "../claude/prompt.ts";
import { invokeClaudeJson } from "../claude/invoke.ts";
import { ReplyResult } from "../claude/schema.ts";
import { findPendingReplies, type ReviewComment, type ThreadState } from "./detect.ts";
import { log } from "../log.ts";

/**
 * Threaded-reply orchestration (#136).
 *
 * Called once per tick per PR that the bot has already reviewed. Fetches
 * the PR's review comments, finds threads where a human has replied
 * after the bot and the bot hasn't answered yet, invokes Claude per
 * pending thread, posts the reply, and updates the watermark.
 *
 * Failures are isolated per-thread so one bad reply doesn't kill the
 * other threads on the same PR. Claude failures feed the shared
 * circuit breaker (same quota guard as the main review path).
 */
export async function respondToThreads(args: {
  gh: GH;
  cfg: Config;
  store: Store;
  repo: RepoRef;
  prNumber: number;
  breaker: Breaker;
}): Promise<{ repliesPosted: number; skipped: number }> {
  const { gh, cfg, store, repo, prNumber, breaker } = args;
  const repoSlug = `${repo.owner}/${repo.name}`;
  const tag = { repo: repoSlug, pr: prNumber };

  const botLogin = cfg.github.bot_username;
  if (!botLogin) return { repliesPosted: 0, skipped: 0 };

  // Pull every review comment on the PR. Octokit paginates for us.
  let raw: RawCommentPayload[];
  try {
    raw = (await gh.paginate(gh.pulls.listReviewComments, {
      owner: repo.owner,
      repo: repo.name,
      pull_number: prNumber,
      per_page: 100,
    })) as RawCommentPayload[];
  } catch (e) {
    log.warn("threads.list_failed", { ...tag, error: (e as Error).message });
    store.recordEvent({
      level: "warn",
      kind: "threads.list_failed",
      message: `Listing review comments on ${repoSlug}#${prNumber} failed: ${(e as Error).message}`,
      repo: repoSlug,
      prNumber,
    });
    return { repliesPosted: 0, skipped: 0 };
  }

  const comments: ReviewComment[] = raw.map((c) => ({
    id: c.id,
    user_login: c.user?.login ?? "",
    in_reply_to_id: c.in_reply_to_id ?? null,
    created_at: c.created_at,
    body: c.body,
    path: c.path,
    line: c.line ?? c.original_line ?? null,
  }));

  const threadRows = store.listReviewThreads(repoSlug, prNumber);
  const threadStates = new Map<number, ThreadState>(
    threadRows.map((r) => [
      r.root_comment_id,
      { root_comment_id: r.root_comment_id, last_responded_to_reply_id: r.last_responded_to_reply_id },
    ]),
  );

  const pending = findPendingReplies({ comments, botLogin, threadStates });
  if (pending.length === 0) return { repliesPosted: 0, skipped: 0 };

  // Resolve the diff once for the whole PR — every pending thread on this
  // PR shares the same head SHA, so re-fetching per thread would be
  // pointless network IO.
  let ctx: Awaited<ReturnType<typeof fetchPrContext>>;
  try {
    ctx = await fetchPrContext(gh, repo, prNumber);
  } catch (e) {
    log.warn("threads.ctx_failed", { ...tag, error: (e as Error).message });
    store.recordEvent({
      level: "warn",
      kind: "threads.ctx_failed",
      message: `Could not fetch PR diff for thread replies on ${repoSlug}#${prNumber}: ${(e as Error).message}`,
      repo: repoSlug,
      prNumber,
    });
    return { repliesPosted: 0, skipped: pending.length };
  }

  const tone = resolveTone({ cfg, owner: repo.owner, name: repo.name });
  const patchByPath = new Map<string, string>();
  for (const f of ctx.files) patchByPath.set(f.path, f.patch);

  let posted = 0;
  let skipped = 0;

  for (const thread of pending) {
    // Shared-budget quota check — reply postings count the same as
    // approval postings, so the bot can't accidentally burn a day's
    // quota on a single noisy thread.
    if (!cfg.review.dry_run) {
      const approvals = store.approvalsInLastHour();
      if (approvals >= cfg.review.max_approvals_per_hour) {
        log.warn("threads.rate_limited", {
          ...tag,
          rootCommentId: thread.rootCommentId,
          approvals,
        });
        store.recordEvent({
          level: "warn",
          kind: "threads.rate_limited",
          message: `Approval cap reached; deferring thread reply on ${repoSlug}#${prNumber}`,
          repo: repoSlug,
          prNumber,
          payload: { rootCommentId: thread.rootCommentId },
        });
        skipped += 1;
        continue;
      }
    }

    const acquire = breaker.tryAcquire();
    if (!acquire.allowed) {
      log.warn("threads.breaker_deferred", { ...tag, rootCommentId: thread.rootCommentId });
      skipped += 1;
      continue;
    }

    const prompt = buildReplyPrompt({
      repo: repoSlug,
      pullNumber: prNumber,
      tone,
      path: thread.path,
      patch: patchByPath.get(thread.path),
      chain: thread.chain.map((c) => ({ author: c.user_login, body: c.body })),
    });

    log.info("threads.invoke", {
      ...tag,
      rootCommentId: thread.rootCommentId,
      chainLength: thread.chain.length,
      promptBytes: prompt.length,
    });

    const result = await invokeClaudeJson({
      command: cfg.claude.command,
      prompt,
      timeoutSeconds: cfg.claude.timeout_seconds,
      schema: ReplyResult,
    });

    if (!result.ok) {
      breaker.recordFailure(result.error);
      log.error("threads.claude_failed", { ...tag, rootCommentId: thread.rootCommentId, error: result.error });
      store.recordEvent({
        level: "error",
        kind: "threads.claude_failed",
        message: `Claude failed to produce a thread reply on ${repoSlug}#${prNumber}: ${result.error}`,
        repo: repoSlug,
        prNumber,
        payload: {
          rootCommentId: thread.rootCommentId,
          stderr: result.stderr?.slice(0, 2000),
        },
      });
      skipped += 1;
      continue;
    }
    breaker.recordSuccess();

    // In dry-run, record the intent but don't post or advance the watermark.
    // Leaving the watermark alone means the next non-dry-run tick will
    // actually reply; this matches the main review path's dry-run semantics.
    if (cfg.review.dry_run) {
      log.info("threads.dry_run", { ...tag, rootCommentId: thread.rootCommentId });
      store.recordEvent({
        level: "info",
        kind: "threads.dry_run",
        message: `dry-run: would reply to ${repoSlug}#${prNumber} thread on ${thread.path}`,
        repo: repoSlug,
        prNumber,
        payload: {
          rootCommentId: thread.rootCommentId,
          replyPreview: result.data.reply.slice(0, 280),
        },
      });
      continue;
    }

    try {
      await gh.pulls.createReplyForReviewComment({
        owner: repo.owner,
        repo: repo.name,
        pull_number: prNumber,
        comment_id: thread.rootCommentId,
        body: result.data.reply,
      });
    } catch (e) {
      log.error("threads.post_failed", { ...tag, rootCommentId: thread.rootCommentId, error: (e as Error).message });
      store.recordEvent({
        level: "error",
        kind: "threads.post_failed",
        message: `Posting thread reply on ${repoSlug}#${prNumber} failed: ${(e as Error).message}`,
        repo: repoSlug,
        prNumber,
        payload: { rootCommentId: thread.rootCommentId },
      });
      skipped += 1;
      continue;
    }

    store.upsertReviewThread({
      repo: repoSlug,
      pr_number: prNumber,
      root_comment_id: thread.rootCommentId,
      last_responded_to_reply_id: thread.latestReplyId,
    });
    store.recordEvent({
      level: "info",
      kind: "threads.replied",
      message: `Replied in ${repoSlug}#${prNumber} thread on ${thread.path}`,
      repo: repoSlug,
      prNumber,
      payload: {
        rootCommentId: thread.rootCommentId,
        latestReplyId: thread.latestReplyId,
      },
    });
    posted += 1;
  }

  return { repliesPosted: posted, skipped };
}

/** Minimal shape of an octokit review-comment payload. Kept local so the
 *  orchestrator doesn't depend on octokit's sprawling generated types. */
type RawCommentPayload = {
  id: number;
  user: { login: string } | null;
  in_reply_to_id?: number;
  created_at: string;
  body: string;
  path: string;
  line?: number | null;
  original_line?: number | null;
};
