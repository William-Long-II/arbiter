import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { PullRequestDiff } from "../src/github";
import type { Intent } from "../src/jira";
import { runChunkedReview } from "../src/review/synthesize";
import { validLinesInPatch } from "../src/review/synthesize";
import * as usageModule from "../src/review/usage";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const intent: Intent = {
  source: "pr-body",
  title: "Big refactor",
  description: "Refactors the entire widget module",
  warnings: [],
};

/**
 * Build a PullRequestDiff whose files total at least `targetChars` patch chars.
 * Each file gets a simple valid diff hunk with a few added lines so the
 * hunk validator has real data to work with.
 */
function makeLargeDiff(targetChars: number): PullRequestDiff {
  const fileCount = Math.ceil(targetChars / 40_000);
  const files = Array.from({ length: fileCount }, (_, i) => {
    const lines = Array.from({ length: 800 }, (__, j) => `+const x${j} = ${j};`);
    const patch = `@@ -0,0 +1,800 @@\n${lines.join("\n")}`;
    return {
      filename: `src/file${i}.ts`,
      status: "modified" as const,
      additions: 800,
      deletions: 0,
      changes: 800,
      patch,
    };
  });

  return {
    owner: "acme",
    repo: "widget",
    number: 42,
    headSha: "deadbeef",
    baseSha: "cafebabe",
    title: "Big refactor",
    body: "Refactors everything",
    files,
    totals: {
      additions: files.length * 800,
      deletions: 0,
      changedFiles: files.length,
    },
  };
}

/** Deterministic pass-1 BatchSummary response for any batch. */
function makeBatchSummaryResponse(filePaths: string[]) {
  return {
    parsed_output: {
      file_summaries: filePaths.map((path) => ({
        path,
        risks: [],
        suspected_bugs: [],
        missing_tests: [],
        notable_changes: [`Updated ${path}`],
      })),
    },
    usage: {
      input_tokens: 500,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/**
 * Pass-2 ReviewResult that includes 3 line comments:
 * - 2 valid (line 1 exists in each file's patch)
 * - 1 invalid (line 9999 does not exist in any hunk)
 */
function makePass2Response() {
  return {
    parsed_output: {
      verdict: "comment",
      summary: "Large refactor looks reasonable overall.",
      lineComments: [
        { path: "src/file0.ts", line: 1, body: "Consider naming this better." },
        { path: "src/file1.ts", line: 2, body: "This could be simplified." },
        { path: "src/file0.ts", line: 9999, body: "This line does not exist." },
      ],
    },
    usage: {
      input_tokens: 1000,
      output_tokens: 400,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    },
  };
}

// ─── Mock Anthropic ───────────────────────────────────────────────────────────

function makeAnthropicMock(diff: PullRequestDiff) {
  let pass2Called = false;
  const pass1Calls: string[][] = [];

  // We detect pass 2 by checking if parsed_output has a `verdict` field
  // (BatchSummarySchema doesn't have verdict; ReviewResultSchema does).
  const stub = {
    messages: {
      parse: async (params: Record<string, unknown>) => {
        // The output_config format name tells us which schema is expected.
        // We detect pass 1 vs pass 2 by whether we've already seen file_summaries format.
        // Simpler: pass 1 prompts contain "Files in this batch"; pass 2 contains "file-by-file summaries".
        const messages = params.messages as Array<{ role: string; content: string }>;
        const userContent = messages[0]?.content ?? "";
        const isPass2 = userContent.toLowerCase().includes("file-by-file summaries");

        if (isPass2) {
          pass2Called = true;
          return makePass2Response();
        } else {
          // Extract file paths from the batch prompt to build the summary.
          const pathMatches = [...userContent.matchAll(/^### (src\/file\d+\.ts)/gm)];
          const filePaths = pathMatches.map((m) => m[1]!);
          pass1Calls.push(filePaths);
          return makeBatchSummaryResponse(filePaths);
        }
      },
    },
  } as unknown as Anthropic;

  return { stub, pass1Calls: () => pass1Calls, pass2Called: () => pass2Called };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runChunkedReview", () => {
  let recordUsageSpy: ReturnType<typeof spyOn<typeof usageModule, "recordUsage">>;

  beforeEach(() => {
    recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(
      undefined,
    );
  });

  afterEach(() => {
    recordUsageSpy.mockRestore();
  });

  test("500 KB diff: calls pass 1 N times then pass 2 once", async () => {
    const diff = makeLargeDiff(500_000);
    const { stub, pass1Calls, pass2Called } = makeAnthropicMock(diff);

    const out = await runChunkedReview(stub, { intent, diff });

    // Pass 1 should have been called multiple times (one per batch).
    expect(pass1Calls().length).toBeGreaterThan(1);
    // Pass 2 should have been called exactly once.
    expect(pass2Called()).toBe(true);
    // Result should be valid.
    expect(out.result.verdict).toBe("comment");
  });

  test("out-of-hunk line comment is dropped with a warning", async () => {
    const diff = makeLargeDiff(500_000);
    const { stub } = makeAnthropicMock(diff);

    const out = await runChunkedReview(stub, { intent, diff });

    // The mock returns 3 comments: 2 valid + 1 at line 9999.
    // Only the 2 valid comments should survive.
    expect(out.result.lineComments).toHaveLength(2);
    expect(out.result.lineComments.every((c) => c.line !== 9999)).toBe(true);

    // At least one warning about the dropped comment.
    expect(out.warnings.some((w) => w.includes("9999"))).toBe(true);
    expect(out.warnings.some((w) => w.includes("dropping line comment"))).toBe(true);
  });

  test("usage recorded twice: once for pass 1 (aggregate), once for pass 2", async () => {
    const diff = makeLargeDiff(500_000);
    const { stub } = makeAnthropicMock(diff);

    await runChunkedReview(stub, { intent, diff });

    // recordUsage should be called exactly twice.
    expect(recordUsageSpy).toHaveBeenCalledTimes(2);

    const calls = recordUsageSpy.mock.calls;
    const pass1Call = calls.find((c) => c[0]?.pass === 1);
    const pass2Call = calls.find((c) => c[0]?.pass === 2);

    expect(pass1Call).toBeDefined();
    expect(pass2Call).toBeDefined();

    // Pass 1 verdict is the sentinel string.
    expect(pass1Call![0]?.verdict).toBe("chunked_pass_1");
    // Pass 2 verdict mirrors the actual review verdict.
    expect(pass2Call![0]?.verdict).toBe("comment");
  });

  test("combined usage totals are returned", async () => {
    const diff = makeLargeDiff(500_000);
    const { stub, pass1Calls } = makeAnthropicMock(diff);

    const out = await runChunkedReview(stub, { intent, diff });

    // Each pass-1 batch: 500 input + 200 output; pass-2: 1000 input + 400 output.
    const batchCount = pass1Calls().length;
    expect(out.usage?.inputTokens).toBe(batchCount * 500 + 1000);
    expect(out.usage?.outputTokens).toBe(batchCount * 200 + 400);
  });
});

// ─── validLinesInPatch ────────────────────────────────────────────────────────

describe("validLinesInPatch", () => {
  test("empty patch returns empty set", () => {
    const lines = validLinesInPatch("");
    expect(lines.size).toBe(0);
  });

  test("basic added lines are valid", () => {
    const patch = `@@ -0,0 +1,3 @@\n+line one\n+line two\n+line three`;
    const lines = validLinesInPatch(patch);
    expect(lines.has(1)).toBe(true);
    expect(lines.has(2)).toBe(true);
    expect(lines.has(3)).toBe(true);
    expect(lines.has(4)).toBe(false);
  });

  test("context lines count as valid (they exist in new file)", () => {
    const patch = `@@ -5,3 +5,3 @@\n context line\n-removed\n+added`;
    const lines = validLinesInPatch(patch);
    expect(lines.has(5)).toBe(true); // context
    expect(lines.has(6)).toBe(true); // added
    expect(lines.has(4)).toBe(false);
  });

  test("deleted lines do NOT appear as valid new-file lines", () => {
    const patch = `@@ -1,2 +1,1 @@\n-deleted line\n+replacement`;
    const lines = validLinesInPatch(patch);
    // Only line 1 in the new file (the replacement)
    expect(lines.has(1)).toBe(true);
    expect(lines.size).toBe(1);
  });

  test("multiple hunks accumulate line numbers correctly", () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      " context",
      "+added at 2",
      "@@ -10,1 +10,2 @@",
      " context at 10",
      "+added at 11",
    ].join("\n");
    const lines = validLinesInPatch(patch);
    expect(lines.has(1)).toBe(true);  // context
    expect(lines.has(2)).toBe(true);  // added
    expect(lines.has(10)).toBe(true); // context
    expect(lines.has(11)).toBe(true); // added
    expect(lines.has(3)).toBe(false);
    expect(lines.has(9)).toBe(false);
  });
});
