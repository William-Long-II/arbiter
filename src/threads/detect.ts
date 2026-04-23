/**
 * Pending-reply detection for threaded review iterations (#136).
 *
 * Given the full list of review comments on a PR plus the bot's login and
 * the last-responded watermark per thread, decide which threads need a
 * new bot reply. A thread "belongs to the bot" if its root comment was
 * authored by the bot; we treat in_reply_to_id chains as the linking
 * mechanism (GitHub's own model).
 *
 * The loop's responsibility is just "for each pending thread, invoke
 * Claude once." This file's responsibility is picking the right threads.
 * Pure function — no IO, no octokit — so the failure cases are all
 * unit-testable.
 */

/** Shape we care about on each review comment from GitHub's API. */
export type ReviewComment = {
  id: number;
  user_login: string;
  /** ID of the comment this reply is threaded under, if any. null = root comment. */
  in_reply_to_id: number | null;
  /** ISO timestamp. Used to order replies chronologically. */
  created_at: string;
  /** Body text — not used for detection, but we pass it through so callers
   *  don't have to re-index. */
  body: string;
  /** Path + line needed by the prompt builder to cite the original context. */
  path: string;
  line: number | null;
};

/** Per-thread state persisted between ticks. */
export type ThreadState = {
  /** Root comment id this thread is rooted at. Bot-authored. */
  root_comment_id: number;
  /**
   * The most recent reply id the bot has already responded to. Replies
   * with `id > last_responded_to_reply_id` AND not authored by the bot
   * are pending.
   */
  last_responded_to_reply_id: number;
};

export type PendingThread = {
  rootCommentId: number;
  path: string;
  /** Ordered comment chain: root bot comment first, then every reply in
   *  created_at order. Used verbatim when building the reply prompt. */
  chain: ReviewComment[];
  /** The most recent reply id in the chain — this becomes the new
   *  watermark after the bot responds. */
  latestReplyId: number;
};

export function findPendingReplies(args: {
  comments: ReviewComment[];
  botLogin: string;
  /** Map from root_comment_id → state. Threads not in the map are
   *  treated as "never responded to" (watermark 0). */
  threadStates: Map<number, ThreadState>;
}): PendingThread[] {
  const { comments, botLogin, threadStates } = args;
  const bot = botLogin.toLowerCase();

  // Step 1: find every bot-authored root comment (no in_reply_to_id).
  const botRoots = comments.filter(
    (c) => c.in_reply_to_id === null && c.user_login.toLowerCase() === bot,
  );
  if (botRoots.length === 0) return [];

  // Step 2: bucket all replies by their in_reply_to_id.
  const repliesByRoot = new Map<number, ReviewComment[]>();
  for (const c of comments) {
    if (c.in_reply_to_id === null) continue;
    const arr = repliesByRoot.get(c.in_reply_to_id) ?? [];
    arr.push(c);
    repliesByRoot.set(c.in_reply_to_id, arr);
  }

  const out: PendingThread[] = [];
  for (const root of botRoots) {
    const replies = (repliesByRoot.get(root.id) ?? [])
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (replies.length === 0) continue;

    // Identify the newest reply and whether it's a non-bot reply the bot
    // hasn't already answered. "Answer" here means: a bot-authored reply
    // that is newer than the human reply. We derive this from the
    // chronological chain rather than from state, so a cold-boot (empty
    // state map) still behaves correctly — if the last reply in the chain
    // is bot-authored, we consider everything handled.
    const last = replies[replies.length - 1]!;
    if (last.user_login.toLowerCase() === bot) continue;

    // Also check the persisted watermark: if someone edited / re-added
    // comments and the highest id is one we've already responded to,
    // skip. This is a belt-and-braces guard — the "last is bot" check
    // already covers the common case.
    const state = threadStates.get(root.id);
    if (state && last.id <= state.last_responded_to_reply_id) continue;

    out.push({
      rootCommentId: root.id,
      path: root.path,
      chain: [root, ...replies],
      latestReplyId: last.id,
    });
  }

  return out;
}
