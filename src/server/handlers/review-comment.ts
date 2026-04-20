/**
 * Handler for pull_request_review_comment.created events.
 *
 * Responds to replies directed at the bot's own review comments, creating a
 * focused conversational follow-up (hunk + thread context) via Anthropic.
 *
 * Rate limit: max 3 bot replies per thread, keyed by parent comment id.
 * Stop sentinel: any reply containing `/stop` (word-boundary, case-insensitive)
 * permanently silences the thread within the TTL window (~24 h).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Octokit } from "../../github";
import { resolveIntent, type JiraCredentials } from "../../jira";
import { withRetry } from "../../util/retry";
import { log } from "../logger";
import { incThreadRateLimited, incThreadReply } from "../metrics";
import { DEFAULT_MODEL } from "../../review";
import { threadTracker } from "./thread-tracker";

export type ReviewCommentDeps = {
  octokit: Octokit;
  anthropic: Anthropic;
  selfLogin: string;
  jiraCreds?: JiraCredentials;
};

/** Word-boundary `/stop` check — "stopping" must not match. */
const STOP_RE = /\bstop\b/i;

/** Max bot replies per thread before rate-limiting. */
const THREAD_REPLY_CAP = 3;

/**
 * System prompt for the short in-thread reply.
 * Kept brief so that the total request stays well under 2 KB.
 */
const THREAD_SYSTEM_PROMPT =
  "You are a code reviewer responding to a follow-up on one of your previous " +
  "review comments. Give a concise, helpful reply (2-4 sentences) that " +
  "directly addresses the developer's question or pushback. " +
  "Reference the specific code hunk when relevant. Be constructive.";

export async function handleReviewCommentCreated(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
  deps: ReviewCommentDeps,
): Promise<void> {
  const { octokit, anthropic, selfLogin, jiraCreds } = deps;

  // 1. Ignore our own comments — avoid infinite reply loops.
  if (payload.comment.user.login === selfLogin) return;

  // 2. Only handle thread replies (not fresh top-level comments).
  const inReplyToId: number | null | undefined = payload.comment.in_reply_to_id;
  if (!inReplyToId) return;

  const owner: string = payload.repository.owner.login;
  const repo: string = payload.repository.name;
  const repoFull: string = payload.repository.full_name;
  const pullNumber: number = payload.pull_request.number;

  // 3. Fetch the parent comment to verify it was authored by the bot.
  let parentComment: Awaited<
    ReturnType<typeof octokit.pulls.getReviewComment>
  >["data"];
  try {
    const resp = await withRetry(() =>
      octokit.pulls.getReviewComment({ owner, repo, comment_id: inReplyToId }),
    );
    parentComment = resp.data;
  } catch (err) {
    log.warn("thread: failed to fetch parent comment", {
      evt: "thread.parent_fetch_failed",
      repo: repoFull,
      pr: pullNumber,
      parentCommentId: inReplyToId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (parentComment.user?.login !== selfLogin) {
    // Parent was not authored by the bot — silently ignore.
    return;
  }

  // 4. Check thread state for stopped flag.
  const state = threadTracker.getOrCreate(repoFull, inReplyToId);
  if (state.stopped) {
    log.info("thread reply skipped: thread stopped", {
      evt: "thread.stopped_skip",
      repo: repoFull,
      pr: pullNumber,
      parentCommentId: inReplyToId,
    });
    return;
  }

  // 5. Check for /stop sentinel in the current reply.
  if (STOP_RE.test(payload.comment.body as string)) {
    state.stopped = true;
    log.info("thread stopped by user", {
      evt: "thread.stopped",
      repo: repoFull,
      pr: pullNumber,
      parentCommentId: inReplyToId,
      commenter: payload.comment.user.login,
    });
    return;
  }

  // 6. Rate-limit: max THREAD_REPLY_CAP bot replies per thread.
  if (state.replies >= THREAD_REPLY_CAP) {
    incThreadRateLimited();
    log.info("thread reply skipped: rate limit reached", {
      evt: "thread.rate_limited",
      repo: repoFull,
      pr: pullNumber,
      parentCommentId: inReplyToId,
      replies: state.replies,
      cap: THREAD_REPLY_CAP,
    });
    return;
  }

  // 7. Fetch PR title/body for intent resolution.
  let prTitle = "";
  let prBody = "";
  try {
    const prResp = await withRetry(() =>
      octokit.pulls.get({ owner, repo, pull_number: pullNumber }),
    );
    prTitle = prResp.data.title ?? "";
    prBody = prResp.data.body ?? "";
  } catch (err) {
    log.warn("thread: failed to fetch PR details", {
      evt: "thread.pr_fetch_failed",
      repo: repoFull,
      pr: pullNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    // Continue with empty title/body — resolveIntent falls back gracefully.
  }

  const intent = await resolveIntent({
    prTitle,
    prBody,
    branch: "",
    creds: jiraCreds,
  });

  // 8. Build a focused prompt. Keep total context small (~2 KB max):
  //    - original hunk from the parent bot comment (may be stale if PR was
  //      force-pushed after the original review, but it is the best context
  //      available without fetching the full diff again)
  //    - parent bot comment body
  //    - the developer's reply
  //    - intent summary
  const intentSummary =
    intent.source === "jira"
      ? `Jira ticket ${intent.ticketKey ?? ""}: ${intent.title}`
      : `PR: ${intent.title}`;

  const hunk = (parentComment.diff_hunk ?? "").slice(0, 800);
  const parentBody = (parentComment.body ?? "").slice(0, 600);
  const replyBody = (payload.comment.body as string).slice(0, 400);

  const userMessage =
    `Context: ${intentSummary}\n\n` +
    `Code hunk:\n\`\`\`diff\n${hunk}\n\`\`\`\n\n` +
    `Your previous comment: ${parentBody}\n\n` +
    `Developer reply: ${replyBody}`;

  // 9. Call Anthropic for the follow-up reply.
  let replyText: string;
  try {
    const response = await withRetry(() =>
      anthropic.messages.create({
        model: DEFAULT_MODEL,
        max_tokens: 1000,
        system: THREAD_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    );
    const first = response.content[0];
    replyText =
      first?.type === "text" ? first.text : "(no response from model)";
  } catch (err) {
    incThreadReply("error");
    log.error("thread: Anthropic call failed", {
      evt: "thread.anthropic_error",
      repo: repoFull,
      pr: pullNumber,
      parentCommentId: inReplyToId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Do NOT post a reply and do NOT increment the reply counter.
    return;
  }

  // 10. Post the reply on GitHub.
  try {
    await withRetry(() =>
      octokit.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: pullNumber,
        comment_id: inReplyToId,
        body: replyText,
      }),
    );
  } catch (err) {
    incThreadReply("error");
    log.error("thread: failed to post reply", {
      evt: "thread.post_failed",
      repo: repoFull,
      pr: pullNumber,
      parentCommentId: inReplyToId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 11. Increment reply counter and record metric on success.
  state.replies += 1;
  incThreadReply("sent");
  log.info("thread reply sent", {
    evt: "thread.reply_sent",
    repo: repoFull,
    pr: pullNumber,
    parentCommentId: inReplyToId,
    replyCount: state.replies,
  });
}
