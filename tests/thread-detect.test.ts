import { describe, expect, test } from "bun:test";
import { findPendingReplies, type ReviewComment, type ThreadState } from "../src/threads/detect.ts";

function c(
  id: number,
  user_login: string,
  in_reply_to_id: number | null,
  created_at: string,
  body = "",
  path = "src/foo.ts",
  line: number | null = 10,
): ReviewComment {
  return { id, user_login, in_reply_to_id, created_at, body, path, line };
}

const BOT = "reviewer-bot";

describe("findPendingReplies", () => {
  test("no comments → empty", () => {
    expect(
      findPendingReplies({ comments: [], botLogin: BOT, threadStates: new Map() }),
    ).toEqual([]);
  });

  test("no bot-authored roots → empty (bot hasn't reviewed this PR)", () => {
    const comments = [
      c(1, "alice", null, "2026-01-01T00:00:00Z", "drive-by human comment"),
      c(2, "bob", 1, "2026-01-02T00:00:00Z", "reply"),
    ];
    expect(
      findPendingReplies({ comments, botLogin: BOT, threadStates: new Map() }),
    ).toEqual([]);
  });

  test("bot root with no replies → empty (nothing to respond to)", () => {
    const comments = [c(10, BOT, null, "2026-01-01T00:00:00Z", "Issue: X")];
    expect(
      findPendingReplies({ comments, botLogin: BOT, threadStates: new Map() }),
    ).toEqual([]);
  });

  test("bot root + single human reply → one pending thread, chain is [root, reply]", () => {
    const comments = [
      c(10, BOT, null, "2026-01-01T00:00:00Z", "Issue: please handle this edge case"),
      c(11, "alice", 10, "2026-01-02T00:00:00Z", "Why is this an issue?"),
    ];
    const result = findPendingReplies({ comments, botLogin: BOT, threadStates: new Map() });
    expect(result).toHaveLength(1);
    expect(result[0]!.rootCommentId).toBe(10);
    expect(result[0]!.latestReplyId).toBe(11);
    expect(result[0]!.chain.map((c) => c.id)).toEqual([10, 11]);
  });

  test("bot has already responded (last reply is bot-authored) → no pending", () => {
    const comments = [
      c(10, BOT, null, "2026-01-01T00:00:00Z"),
      c(11, "alice", 10, "2026-01-02T00:00:00Z", "question"),
      c(12, BOT, 10, "2026-01-03T00:00:00Z", "answer"),
    ];
    expect(
      findPendingReplies({ comments, botLogin: BOT, threadStates: new Map() }),
    ).toEqual([]);
  });

  test("human replies again after bot's answer → pending (last reply is human)", () => {
    const comments = [
      c(10, BOT, null, "2026-01-01T00:00:00Z"),
      c(11, "alice", 10, "2026-01-02T00:00:00Z", "question 1"),
      c(12, BOT, 10, "2026-01-03T00:00:00Z", "answer 1"),
      c(13, "alice", 10, "2026-01-04T00:00:00Z", "follow-up"),
    ];
    const result = findPendingReplies({ comments, botLogin: BOT, threadStates: new Map() });
    expect(result).toHaveLength(1);
    expect(result[0]!.latestReplyId).toBe(13);
    // Full chain preserved so the prompt can show prior exchanges.
    expect(result[0]!.chain.map((c) => c.id)).toEqual([10, 11, 12, 13]);
  });

  test("watermark blocks redundant responses when last is human but was already answered", () => {
    // Edge case: we recorded state that we responded to reply 13, but the
    // comment listing somehow doesn't include our reply (API eventual
    // consistency). The bot-authored-last check passes (last IS human
    // id=13), but the watermark saves us from double-replying.
    const comments = [
      c(10, BOT, null, "2026-01-01T00:00:00Z"),
      c(11, "alice", 10, "2026-01-02T00:00:00Z"),
      c(13, "alice", 10, "2026-01-04T00:00:00Z"),
    ];
    const state = new Map<number, ThreadState>([
      [10, { root_comment_id: 10, last_responded_to_reply_id: 13 }],
    ]);
    expect(findPendingReplies({ comments, botLogin: BOT, threadStates: state })).toEqual([]);
  });

  test("multiple bot threads on same PR — each one independently", () => {
    const comments = [
      c(10, BOT, null, "2026-01-01T00:00:00Z", "", "src/a.ts"),
      c(20, BOT, null, "2026-01-01T00:01:00Z", "", "src/b.ts"),
      c(30, BOT, null, "2026-01-01T00:02:00Z", "", "src/c.ts"),
      c(11, "alice", 10, "2026-01-02T00:00:00Z"), // pending
      c(21, BOT, 20, "2026-01-02T00:00:00Z"), // already answered
      // thread 30 has no replies
    ];
    const result = findPendingReplies({ comments, botLogin: BOT, threadStates: new Map() });
    expect(result.map((t) => t.rootCommentId)).toEqual([10]);
    expect(result[0]!.path).toBe("src/a.ts");
  });

  test("case-insensitive bot login match", () => {
    const comments = [
      c(10, "Reviewer-Bot", null, "2026-01-01T00:00:00Z"),
      c(11, "alice", 10, "2026-01-02T00:00:00Z"),
    ];
    const result = findPendingReplies({
      comments,
      botLogin: "reviewer-bot",
      threadStates: new Map(),
    });
    expect(result).toHaveLength(1);
  });

  test("replies sorted by created_at regardless of arrival order in the array", () => {
    // Simulate the API returning comments out of order (it usually doesn't,
    // but the detector shouldn't depend on that).
    const comments = [
      c(10, BOT, null, "2026-01-01T00:00:00Z"),
      c(13, "alice", 10, "2026-01-04T00:00:00Z", "newest"),
      c(11, "alice", 10, "2026-01-02T00:00:00Z", "oldest reply"),
      c(12, BOT, 10, "2026-01-03T00:00:00Z", "middle bot reply"),
    ];
    const result = findPendingReplies({ comments, botLogin: BOT, threadStates: new Map() });
    expect(result).toHaveLength(1);
    expect(result[0]!.chain.map((c) => c.id)).toEqual([10, 11, 12, 13]);
    expect(result[0]!.latestReplyId).toBe(13);
  });

  test("reply chain under a non-bot root is ignored", () => {
    const comments = [
      c(50, "alice", null, "2026-01-01T00:00:00Z", "alice's own drive-by thread"),
      c(51, "bob", 50, "2026-01-02T00:00:00Z"),
    ];
    expect(
      findPendingReplies({ comments, botLogin: BOT, threadStates: new Map() }),
    ).toEqual([]);
  });
});
