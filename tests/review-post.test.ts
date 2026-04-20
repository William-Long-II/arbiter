import { describe, expect, test } from "bun:test";
import type { Octokit } from "../src/github";
import { postReview } from "../src/github/review";
import type { ReviewResult } from "../src/review";

type Review = {
  user: { login: string } | null;
  commit_id: string;
};

type CreateReviewArgs = {
  owner: string;
  repo: string;
  pull_number: number;
  commit_id: string;
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  body?: string;
  comments?: Array<{ path: string; line: number; side: string; body: string }>;
};

function stubOctokit(opts: {
  existingReviews?: Review[];
  failFirstCreate?: { message: string };
}) {
  const createCalls: CreateReviewArgs[] = [];
  const existing = opts.existingReviews ?? [];
  let createCallCount = 0;

  const octokit = {
    paginate: {
      iterator: async function* () {
        yield { data: existing };
      },
    },
    pulls: {
      listReviews: {} as unknown,
      createReview: async (args: CreateReviewArgs) => {
        createCalls.push(args);
        createCallCount += 1;
        if (opts.failFirstCreate && createCallCount === 1) {
          throw new Error(opts.failFirstCreate.message);
        }
        return { data: { id: 5000 + createCallCount } };
      },
    },
  } as unknown as Octokit;

  return { octokit, createCalls };
}

const approve: ReviewResult = {
  verdict: "approve",
  summary: "all good",
  lineComments: [],
};

const commentWithLines: ReviewResult = {
  verdict: "comment",
  summary: "a few nits",
  lineComments: [
    { path: "src/a.ts", line: 10, body: "consider X" },
    { path: "src/b.ts", line: 2, body: "extract Y" },
  ],
};

const ref = {
  owner: "acme",
  repo: "widget",
  pullNumber: 1,
  headSha: "abc123",
  selfLogin: "reviewme-bot",
};

describe("postReview", () => {
  test("posts APPROVE with no comments when verdict is approve", async () => {
    const { octokit, createCalls } = stubOctokit({});
    const out = await postReview(octokit, { ...ref, review: approve });
    expect(out.status).toBe("posted");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.event).toBe("APPROVE");
    expect(createCalls[0]?.comments).toEqual([]);
  });

  test("posts COMMENT with line comments when verdict is comment", async () => {
    const { octokit, createCalls } = stubOctokit({});
    const out = await postReview(octokit, {
      ...ref,
      review: commentWithLines,
    });
    expect(out.status).toBe("posted");
    if (out.status === "posted") {
      expect(out.includedComments).toBe(2);
    }
    expect(createCalls[0]?.event).toBe("COMMENT");
    expect(createCalls[0]?.comments?.[0]).toMatchObject({
      path: "src/a.ts",
      line: 10,
      side: "RIGHT",
      body: "consider X",
    });
  });

  test("never posts REQUEST_CHANGES", async () => {
    const { octokit, createCalls } = stubOctokit({});
    await postReview(octokit, { ...ref, review: commentWithLines });
    expect(createCalls[0]?.event).not.toBe("REQUEST_CHANGES");
  });

  test("skips when the bot has already reviewed this head SHA", async () => {
    const { octokit, createCalls } = stubOctokit({
      existingReviews: [
        { user: { login: "reviewme-bot" }, commit_id: "abc123" },
      ],
    });
    const out = await postReview(octokit, { ...ref, review: approve });
    expect(out.status).toBe("skipped");
    expect(createCalls).toHaveLength(0);
  });

  test("does not skip when a prior review was on a different head SHA", async () => {
    const { octokit, createCalls } = stubOctokit({
      existingReviews: [
        { user: { login: "reviewme-bot" }, commit_id: "older-sha" },
      ],
    });
    const out = await postReview(octokit, { ...ref, review: approve });
    expect(out.status).toBe("posted");
    expect(createCalls).toHaveLength(1);
  });

  test("does not skip when a prior review was posted by a different user", async () => {
    const { octokit, createCalls } = stubOctokit({
      existingReviews: [
        { user: { login: "some-human" }, commit_id: "abc123" },
      ],
    });
    const out = await postReview(octokit, { ...ref, review: approve });
    expect(out.status).toBe("posted");
    expect(createCalls).toHaveLength(1);
  });

  test("falls back to summary-only when inline comments cannot be anchored", async () => {
    const { octokit, createCalls } = stubOctokit({
      failFirstCreate: { message: "422 Unprocessable Entity: line not in diff" },
    });
    const out = await postReview(octokit, {
      ...ref,
      review: commentWithLines,
    });
    expect(out.status).toBe("posted-summary-only");
    expect(createCalls).toHaveLength(2);
    expect(createCalls[1]?.comments).toBeUndefined();
    expect(createCalls[1]?.body).toContain("inline comments were generated");
  });

  test("rethrows when the summary-only retry also fails", async () => {
    // The retry path only fires when there are line comments; simulate both creates failing.
    const octokit = {
      paginate: {
        iterator: async function* () {
          yield { data: [] };
        },
      },
      pulls: {
        listReviews: {} as unknown,
        createReview: async () => {
          throw new Error("boom");
        },
      },
    } as unknown as Octokit;

    await expect(
      postReview(octokit, { ...ref, review: commentWithLines }),
    ).rejects.toThrow(/boom/);
  });
});
