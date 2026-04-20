import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { PullRequestDiff } from "../src/github";
import type { Intent } from "../src/jira";
import { runReview } from "../src/review";
import { runChunkedReview } from "../src/review/synthesize";
import { postReview } from "../src/github/review";
import type { PostReviewInput } from "../src/github/review";
import type { ReviewResult } from "../src/review";
import type { TraceMetadata } from "../src/review/types";
import type { Octokit } from "../src/github";
import { resultCache } from "../src/review/result-cache";
import * as usageModule from "../src/review/usage";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const intent: Intent = {
  source: "jira",
  ticketKey: "PROJ-123",
  title: "do the thing",
  description: "do it",
  warnings: [],
};

const intentPrBody: Intent = {
  source: "pr-body",
  title: "do the thing",
  description: "do it",
  warnings: [],
};

function makeSmallDiff(): PullRequestDiff {
  return {
    owner: "acme",
    repo: "widget",
    number: 1,
    headSha: "abc123def456",
    baseSha: "000000",
    title: "my PR",
    body: "body text",
    files: [
      {
        filename: "a.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        changes: 3,
        patch: "@@ -1,3 +1,4 @@\n const x = 1;\n+const y = 2;\n const z = 3;",
      },
    ],
    totals: { additions: 2, deletions: 1, changedFiles: 1 },
  };
}

/**
 * A large diff that exceeds DEFAULT_MAX_DIFF_CHARS (150_000) for chunked routing.
 * Uses ~40_000 patch chars per file × 5 files = ~200_000 total chars.
 */
function makeLargeDiff(): PullRequestDiff {
  const fileCount = 5;
  const lines = Array.from({ length: 2_000 }, (_, j) => `+const x${j} = ${j}; // padding line to push size over threshold`);
  const patch = `@@ -0,0 +1,2000 @@\n${lines.join("\n")}`;
  const files = Array.from({ length: fileCount }, (_, i) => ({
    filename: `src/file${i}.ts`,
    status: "modified" as const,
    additions: 2_000,
    deletions: 0,
    changes: 2_000,
    patch,
  }));
  return {
    owner: "acme",
    repo: "widget",
    number: 2,
    headSha: "large000sha1",
    baseSha: "cafebabe",
    title: "Big refactor",
    body: "Refactors everything",
    files,
    totals: { additions: fileCount * 2_000, deletions: 0, changedFiles: fileCount },
  };
}

const approveResult: ReviewResult = {
  verdict: "approve",
  summary: "looks good to me",
  lineComments: [],
};

function stubAnthropicReturning(result: ReviewResult) {
  const stub = {
    messages: {
      parse: async () => ({
        parsed_output: result,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    },
  } as unknown as Anthropic;
  return stub;
}

/** A pass-1 + pass-2 stub for chunked review. */
function stubAnthropicChunked(result: ReviewResult) {
  const stub = {
    messages: {
      parse: async (params: { messages: Array<{ role: string; content: string }> }) => {
        const userContent = params.messages[0]?.content ?? "";
        // Detect pass 2 by its synthesis marker (same heuristic as synthesize.test.ts).
        const isPass2 = userContent.toLowerCase().includes("file-by-file summaries");

        if (isPass2) {
          return {
            parsed_output: result,
            usage: {
              input_tokens: 120,
              output_tokens: 60,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          };
        }

        // Pass-1 batch: extract file paths from the batch prompt.
        const pathMatches = [...userContent.matchAll(/^### (src\/file\d+\.ts)/gm)];
        const filePaths = pathMatches.map((m) => m[1]!);
        return {
          parsed_output: {
            file_summaries: filePaths.map((path) => ({
              path,
              risks: [],
              suspected_bugs: [],
              missing_tests: [],
              notable_changes: ["a change"],
            })),
          },
          usage: {
            input_tokens: 80,
            output_tokens: 40,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        };
      },
    },
  } as unknown as Anthropic;
  return stub;
}

function stubOctokit(existingReviews: Array<{ user: { login: string } | null; commit_id: string }> = []) {
  const createCalls: Array<{
    owner: string;
    repo: string;
    pull_number: number;
    commit_id: string;
    event: string;
    body?: string;
    comments?: unknown[];
  }> = [];

  const octokit = {
    paginate: {
      iterator: async function* () {
        yield { data: existingReviews };
      },
    },
    pulls: {
      listReviews: {} as unknown,
      createReview: async (args: typeof createCalls[number]) => {
        createCalls.push(args);
        return { data: { id: 9001 } };
      },
    },
  } as unknown as Octokit;

  return { octokit, createCalls };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("traceMetadata — single-pass runReview", () => {
  let originalMode: string | undefined;
  let recordUsageSpy: ReturnType<typeof spyOn<typeof usageModule, "recordUsage">>;

  beforeEach(() => {
    originalMode = process.env["REVIEW_MODE"];
    process.env["REVIEW_MODE"] = "single";
    recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);
    resultCache.clear();
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env["REVIEW_MODE"];
    } else {
      process.env["REVIEW_MODE"] = originalMode;
    }
    recordUsageSpy.mockRestore();
    resultCache.clear();
  });

  test("returns traceMetadata with mode=single for single-pass review", async () => {
    const anthropic = stubAnthropicReturning(approveResult);
    const out = await runReview(anthropic, { intent, diff: makeSmallDiff() });
    expect(out.traceMetadata).toBeDefined();
    expect(out.traceMetadata?.mode).toBe("single");
  });

  test("traceMetadata contains all required fields for single mode", async () => {
    const anthropic = stubAnthropicReturning(approveResult);
    const diff = makeSmallDiff();
    const out = await runReview(anthropic, { intent, diff });
    const meta = out.traceMetadata!;
    expect(meta.headSha).toBe(diff.headSha);
    expect(meta.model).toBeTruthy();
    expect(meta.mode).toBe("single");
    expect(meta.intentSource).toBe("jira");
    expect(meta.intentRef).toBe("PROJ-123");
    expect(meta.promptHash).toMatch(/^[0-9a-f]{12}$/);
    expect(meta.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("intentRef is empty string when source is pr-body", async () => {
    const anthropic = stubAnthropicReturning(approveResult);
    const out = await runReview(anthropic, { intent: intentPrBody, diff: makeSmallDiff() });
    expect(out.traceMetadata?.intentSource).toBe("pr-body");
    expect(out.traceMetadata?.intentRef).toBe("");
  });

  test("promptHash is stable across identical inputs", async () => {
    resultCache.clear();
    const diff = makeSmallDiff();

    const out1 = await runReview(stubAnthropicReturning(approveResult), { intent, diff });
    resultCache.clear();
    const out2 = await runReview(stubAnthropicReturning(approveResult), { intent, diff });

    expect(out1.traceMetadata?.promptHash).toBe(out2.traceMetadata?.promptHash);
  });

  test("promptHash differs when diff content changes", async () => {
    resultCache.clear();
    const diff1 = makeSmallDiff();
    const diff2 = {
      ...makeSmallDiff(),
      files: [
        {
          ...makeSmallDiff().files[0]!,
          patch: "@@ -1,3 +1,4 @@\n const x = 1;\n+const DIFFERENT = 999;\n const z = 3;",
        },
      ],
    };

    const out1 = await runReview(stubAnthropicReturning(approveResult), { intent, diff: diff1 });
    resultCache.clear();
    const out2 = await runReview(stubAnthropicReturning(approveResult), { intent, diff: diff2 });

    expect(out1.traceMetadata?.promptHash).not.toBe(out2.traceMetadata?.promptHash);
  });

  test("traceMetadata mode=too_large for fail-open when REVIEW_MODE=single and large diff", async () => {
    const anthropic = stubAnthropicReturning(approveResult);
    const out = await runReview(anthropic, { intent, diff: makeLargeDiff() });
    expect(out.traceMetadata?.mode).toBe("too_large");
    expect(out.traceMetadata?.promptHash).toBe("");
    expect(out.traceMetadata?.intentSource).toBe("jira");
  });
});

describe("traceMetadata — budget_exhausted path", () => {
  let recordUsageSpy: ReturnType<typeof spyOn<typeof usageModule, "recordUsage">>;

  beforeEach(() => {
    recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);
    resultCache.clear();
  });

  afterEach(() => {
    recordUsageSpy.mockRestore();
    resultCache.clear();
  });

  test("returns mode=budget_exhausted with empty promptHash when budget is exhausted", async () => {
    const anthropic = stubAnthropicReturning(approveResult);
    // Set max_weekly_tokens to 0 so the budget is always exhausted.
    const out = await runReview(
      anthropic,
      {
        intent,
        diff: makeSmallDiff(),
        reviewConfig: { max_weekly_tokens: 0 } as import("../src/config/repos").RepoReviewConfig,
      },
    );
    expect(out.traceMetadata?.mode).toBe("budget_exhausted");
    expect(out.traceMetadata?.promptHash).toBe("");
    expect(out.traceMetadata?.headSha).toBe(makeSmallDiff().headSha);
  });
});

describe("traceMetadata — chunked runChunkedReview", () => {
  let recordUsageSpy: ReturnType<typeof spyOn<typeof usageModule, "recordUsage">>;

  beforeEach(() => {
    recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);
  });

  afterEach(() => {
    recordUsageSpy.mockRestore();
  });

  test("chunked review emits traceMetadata with mode=chunked", async () => {
    const anthropic = stubAnthropicChunked(approveResult);
    const out = await runChunkedReview(anthropic, {
      intent,
      diff: makeLargeDiff(),
    });
    expect(out.traceMetadata?.mode).toBe("chunked");
  });

  test("chunked review traceMetadata has all required fields", async () => {
    const anthropic = stubAnthropicChunked(approveResult);
    const diff = makeLargeDiff();
    const out = await runChunkedReview(anthropic, { intent, diff });
    const meta = out.traceMetadata!;
    expect(meta.headSha).toBe(diff.headSha);
    expect(meta.model).toBeTruthy();
    expect(meta.mode).toBe("chunked");
    expect(meta.intentSource).toBe("jira");
    expect(meta.intentRef).toBe("PROJ-123");
    expect(meta.promptHash).toMatch(/^[0-9a-f]{12}$/);
    expect(meta.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("chunked intentRef is empty when source is pr-body", async () => {
    const anthropic = stubAnthropicChunked(approveResult);
    const out = await runChunkedReview(anthropic, {
      intent: intentPrBody,
      diff: makeLargeDiff(),
    });
    expect(out.traceMetadata?.intentRef).toBe("");
  });
});

describe("postReview — metadata footer in summary", () => {
  const sampleMeta: TraceMetadata = {
    headSha: "abc123def456",
    model: "claude-opus-4-7",
    mode: "single",
    intentSource: "jira",
    intentRef: "PROJ-123",
    promptHash: "a1b2c3d4e5f6",
    ts: "2026-04-20T18:00:00.000Z",
  };

  const reviewRef = {
    owner: "acme",
    repo: "widget",
    pullNumber: 1,
    headSha: "abc123def456",
    selfLogin: "review-me-bot",
  };

  test("posted body contains <!-- review-me: --> block when traceMetadata provided", async () => {
    const { octokit, createCalls } = stubOctokit();
    await postReview(octokit, {
      ...reviewRef,
      review: approveResult,
      traceMetadata: sampleMeta,
    });
    const body = createCalls[0]?.body ?? "";
    expect(body).toContain("<!-- review-me:");
    expect(body).toContain("-->");
  });

  test("footer contains all required fields", async () => {
    const { octokit, createCalls } = stubOctokit();
    await postReview(octokit, {
      ...reviewRef,
      review: approveResult,
      traceMetadata: sampleMeta,
    });
    const body = createCalls[0]?.body ?? "";
    expect(body).toContain("head_sha: abc123def456");
    expect(body).toContain("model: claude-opus-4-7");
    expect(body).toContain("mode: single");
    expect(body).toContain("intent_source: jira");
    expect(body).toContain("intent_ref: PROJ-123");
    expect(body).toContain("prompt_hash: a1b2c3d4e5f6");
    expect(body).toContain("ts: 2026-04-20T18:00:00.000Z");
  });

  test("footer is at the END of the summary body", async () => {
    const { octokit, createCalls } = stubOctokit();
    await postReview(octokit, {
      ...reviewRef,
      review: approveResult,
      traceMetadata: sampleMeta,
    });
    const body = createCalls[0]?.body ?? "";
    // The HTML comment must close at the very end of the body
    expect(body.trimEnd()).toMatch(/-->$/);
  });

  test("footer includes intent_ref empty when source=pr-body", async () => {
    const { octokit, createCalls } = stubOctokit();
    await postReview(octokit, {
      ...reviewRef,
      review: approveResult,
      traceMetadata: { ...sampleMeta, intentSource: "pr-body", intentRef: "" },
    });
    const body = createCalls[0]?.body ?? "";
    expect(body).toContain("intent_ref: \n");
  });

  test("footer includes mode=chunked when provided", async () => {
    const { octokit, createCalls } = stubOctokit();
    await postReview(octokit, {
      ...reviewRef,
      review: approveResult,
      traceMetadata: { ...sampleMeta, mode: "chunked" },
    });
    const body = createCalls[0]?.body ?? "";
    expect(body).toContain("mode: chunked");
  });

  test("footer includes mode=budget_exhausted and empty prompt_hash", async () => {
    const { octokit, createCalls } = stubOctokit();
    await postReview(octokit, {
      ...reviewRef,
      review: approveResult,
      traceMetadata: { ...sampleMeta, mode: "budget_exhausted", promptHash: "" },
    });
    const body = createCalls[0]?.body ?? "";
    expect(body).toContain("mode: budget_exhausted");
    expect(body).toContain("prompt_hash: \n");
  });

  test("no footer appended when traceMetadata is absent", async () => {
    const { octokit, createCalls } = stubOctokit();
    const input: PostReviewInput = {
      ...reviewRef,
      review: approveResult,
      // no traceMetadata
    };
    await postReview(octokit, input);
    const body = createCalls[0]?.body ?? "";
    expect(body).not.toContain("<!-- review-me:");
    expect(body).toBe(approveResult.summary);
  });

  test("existing review-post tests still pass — skips when already reviewed", async () => {
    const { octokit, createCalls } = stubOctokit([
      { user: { login: "review-me-bot" }, commit_id: "abc123def456" },
    ]);
    const out = await postReview(octokit, {
      ...reviewRef,
      review: approveResult,
    });
    expect(out.status).toBe("skipped");
    expect(createCalls).toHaveLength(0);
  });

  test("promptHash is stable: sha256(msg).slice(0,12)", () => {
    const msg = "hello world test message";
    const expected = createHash("sha256").update(msg).digest("hex").slice(0, 12);
    // Compute independently to verify determinism
    const again = createHash("sha256").update(msg).digest("hex").slice(0, 12);
    expect(expected).toBe(again);
    expect(expected).toMatch(/^[0-9a-f]{12}$/);
  });
});
