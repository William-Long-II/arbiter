/**
 * Tests for issue #77: reviewme_prompt_user_bytes histogram.
 *
 * Coverage:
 *   - observePromptUserBytes with zero-length input (no error)
 *   - observePromptUserBytes with a normal-sized input (correct bucket)
 *   - Single-pass runReview emits exactly one observation + one prompt.size log
 *   - Chunked-path runChunkedReview emits exactly one pass-2 observation
 *   - Budget-exhausted and too-large fail-open paths emit NO observation
 *   - reviewme_review_duration_seconds is unaffected (regression guard)
 */

import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { PullRequestDiff } from "../src/github";
import type { Intent } from "../src/jira";
import { runReview } from "../src/review";
import { resultCache } from "../src/review/result-cache";
import * as synthesizeModule from "../src/review/synthesize";
import * as usageModule from "../src/review/usage";
import * as loggerModule from "../src/server/logger";
import * as metricsModule from "../src/server/metrics";

// ---------------------------------------------------------------------------
// Helpers shared across test suites
// ---------------------------------------------------------------------------

function makeDiff(patchChars: number, repo = "widget"): PullRequestDiff {
  return {
    owner: "acme",
    repo,
    number: 1,
    headSha: "abc123",
    baseSha: "def456",
    title: "title",
    body: "body",
    files: [
      {
        filename: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "x".repeat(patchChars),
      },
    ],
    totals: { additions: 1, deletions: 0, changedFiles: 1 },
  };
}

const intent: Intent = {
  source: "pr-body",
  title: "test change",
  description: "test description",
  warnings: [],
};

type ReviewResult = {
  verdict: "approve" | "comment";
  summary: string;
  lineComments: never[];
};

function makeAnthropicStub(result: ReviewResult): Anthropic {
  return {
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
}

// ---------------------------------------------------------------------------
// Unit tests — observePromptUserBytes directly on the live registry
// ---------------------------------------------------------------------------

describe("observePromptUserBytes — registry unit tests", () => {
  test("zero-length observation does not throw", () => {
    // A zero-byte message is unusual but the metric must handle it gracefully.
    expect(() => metricsModule.observePromptUserBytes(0)).not.toThrow();
  });

  test("normal-sized observation (5000 bytes) lands in the correct bucket", () => {
    // Access the live registry internals for inspection.
    const reg = (metricsModule.registry as unknown as {
      histograms: Map<string, {
        series: Map<string, {
          sum: number;
          count: number;
          buckets: Map<number, number>;
        }>;
      }>;
    }).histograms;

    const metricName = metricsModule.promptUserBytes;
    const before = reg.get(metricName)?.series.get("")?.count ?? 0;

    metricsModule.observePromptUserBytes(5000);

    const state = reg.get(metricName)?.series.get("")!;
    expect(state.count).toBe(before + 1);
    expect(state.sum).toBeGreaterThanOrEqual(5000);

    // 5000 bytes should land in the 4096-16384 bucket but NOT in the 4096 bucket.
    const bucket4096 = state.buckets.get(4096) ?? 0;
    const bucket16384 = state.buckets.get(16384) ?? 0;
    // Cumulative: 4096 bucket should NOT include 5000-byte observation.
    // bucket16384 count should be >= bucket4096 count + 1 (the new 5000-byte observation).
    expect(bucket16384).toBeGreaterThan(bucket4096);
  });

  test("reviewme_review_duration_seconds histogram is unaffected by prompt observation", () => {
    const reg = (metricsModule.registry as unknown as {
      histograms: Map<string, {
        series: Map<string, { count: number }>;
      }>;
    }).histograms;

    const durationBefore = reg.get(metricsModule.reviewDuration)?.series.get("")?.count ?? 0;
    metricsModule.observePromptUserBytes(2048);
    const durationAfter = reg.get(metricsModule.reviewDuration)?.series.get("")?.count ?? 0;

    expect(durationAfter).toBe(durationBefore);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — single-pass runReview
// ---------------------------------------------------------------------------

describe("runReview — prompt.size metric (single-pass)", () => {
  let originalMode: string | undefined;
  let recordUsageSpy: ReturnType<typeof spyOn<typeof usageModule, "recordUsage">>;
  let observeSpy: ReturnType<typeof spyOn<typeof metricsModule, "observePromptUserBytes">>;
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalMode = process.env["REVIEW_MODE"];
    process.env["REVIEW_MODE"] = "single";
    resultCache.clear();
    recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);
    observeSpy = spyOn(metricsModule, "observePromptUserBytes").mockImplementation(() => {});
    infoSpy = spyOn(loggerModule.log, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env["REVIEW_MODE"];
    } else {
      process.env["REVIEW_MODE"] = originalMode;
    }
    recordUsageSpy.mockRestore();
    observeSpy.mockRestore();
    infoSpy.mockRestore();
  });

  test("single runReview call emits exactly one histogram observation", async () => {
    const stub = makeAnthropicStub({ verdict: "approve", summary: "lgtm", lineComments: [] });

    await runReview(stub, { intent, diff: makeDiff(100) });

    expect(observeSpy).toHaveBeenCalledTimes(1);
    const [bytes] = observeSpy.mock.calls[0] as [number];
    expect(typeof bytes).toBe("number");
    expect(bytes).toBeGreaterThan(0);
  });

  test("single runReview call with large enough prompt emits one prompt.size log", async () => {
    // Use a large patch to ensure the prompt exceeds the 1KB log threshold.
    const stub = makeAnthropicStub({ verdict: "approve", summary: "lgtm", lineComments: [] });

    await runReview(stub, { intent, diff: makeDiff(2000) });

    const sizeLogs = (infoSpy.mock.calls as unknown[][]).filter(
      (call) => (call[1] as Record<string, unknown>)?.evt === "prompt.size",
    );
    expect(sizeLogs).toHaveLength(1);

    const fields = sizeLogs[0]?.[1] as Record<string, unknown>;
    expect(fields.mode).toBe("single");
    expect(fields.repo).toBe("acme/widget");
    expect(fields.pr).toBe(1);
    expect(typeof fields.user_message_bytes).toBe("number");
    expect(fields.headSha).toBe("abc123");
  });

  test("budget-exhausted path emits NO histogram observation", async () => {
    const stub = makeAnthropicStub({ verdict: "approve", summary: "lgtm", lineComments: [] });

    await runReview(stub, {
      intent,
      diff: makeDiff(100),
      reviewConfig: { max_weekly_tokens: 0 },
    });

    expect(observeSpy).not.toHaveBeenCalled();
  });

  test("too-large fail-open path emits NO histogram observation", async () => {
    const stub = makeAnthropicStub({ verdict: "approve", summary: "lgtm", lineComments: [] });

    await runReview(stub, { intent, diff: makeDiff(500) }, { maxDiffChars: 100 });

    expect(observeSpy).not.toHaveBeenCalled();
  });

  test("result-cache hit emits NO new histogram observation", async () => {
    const stub = makeAnthropicStub({ verdict: "approve", summary: "lgtm", lineComments: [] });

    // First call — populates the cache.
    await runReview(stub, { intent, diff: makeDiff(100) });
    const countAfterFirst = observeSpy.mock.calls.length;

    // Second call with same headSha — should be served from cache.
    await runReview(stub, { intent, diff: makeDiff(100) });
    expect(observeSpy.mock.calls.length).toBe(countAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — chunked path (pass-2 synthesis message)
// ---------------------------------------------------------------------------

describe("runChunkedReview — prompt.size metric (pass-2 only)", () => {
  let recordUsageSpy: ReturnType<typeof spyOn<typeof usageModule, "recordUsage">>;
  let observeSpy: ReturnType<typeof spyOn<typeof metricsModule, "observePromptUserBytes">>;
  let infoSpy: ReturnType<typeof spyOn>;

  const pass1Response = {
    parsed_output: {
      file_summaries: [
        {
          path: "src/file.ts",
          risks: [],
          suspected_bugs: [],
          missing_tests: [],
          notable_changes: ["some change"],
        },
      ],
    },
    usage: {
      input_tokens: 50,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };

  const pass2Response = {
    parsed_output: {
      verdict: "approve",
      summary: "all good",
      lineComments: [],
    },
    usage: {
      input_tokens: 80,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };

  beforeEach(() => {
    resultCache.clear();
    recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);
    observeSpy = spyOn(metricsModule, "observePromptUserBytes").mockImplementation(() => {});
    infoSpy = spyOn(loggerModule.log, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    recordUsageSpy.mockRestore();
    observeSpy.mockRestore();
    infoSpy.mockRestore();
  });

  test("chunked runChunkedReview emits exactly one observation for the pass-2 synthesis message", async () => {
    // Two-call stub: first call returns pass-1 batch summary, second returns pass-2 synthesis.
    let callCount = 0;
    const stub = {
      messages: {
        parse: async () => {
          callCount++;
          return callCount === 1 ? pass1Response : pass2Response;
        },
      },
    } as unknown as Anthropic;

    const diff: PullRequestDiff = {
      owner: "acme",
      repo: "widget",
      number: 42,
      headSha: "feed1234",
      baseSha: "cafe5678",
      title: "chunked test",
      body: "",
      files: [
        {
          filename: "src/file.ts",
          status: "modified",
          additions: 5,
          deletions: 0,
          changes: 5,
          patch: "@@ -1,1 +1,5 @@\n+const a = 1;\n+const b = 2;\n+const c = 3;\n+const d = 4;\n+const e = 5;",
        },
      ],
      totals: { additions: 5, deletions: 0, changedFiles: 1 },
    };

    await synthesizeModule.runChunkedReview(stub, { intent, diff });

    // Only the pass-2 synthesis message should be observed (not pass-1 batch messages).
    expect(observeSpy).toHaveBeenCalledTimes(1);
    const [bytes] = observeSpy.mock.calls[0] as [number];
    expect(typeof bytes).toBe("number");
    expect(bytes).toBeGreaterThan(0);
  });

  test("chunked pass-2 prompt.size log has mode=chunked", async () => {
    let callCount = 0;
    const stub = {
      messages: {
        parse: async () => {
          callCount++;
          return callCount === 1 ? pass1Response : pass2Response;
        },
      },
    } as unknown as Anthropic;

    // Use a large synthesis message to ensure bytes >= 1KB log threshold.
    // We achieve that by providing a diff with a long body.
    const diff: PullRequestDiff = {
      owner: "acme",
      repo: "widget",
      number: 42,
      headSha: "feed5678",
      baseSha: "cafe1234",
      title: "chunked log test",
      // Long body ensures intent section pushes synthesis message over 1KB
      body: "x".repeat(2000),
      files: [
        {
          filename: "src/main.ts",
          status: "modified",
          additions: 5,
          deletions: 0,
          changes: 5,
          patch: "@@ -1,1 +1,5 @@\n+const a = 1;\n+const b = 2;\n+const c = 3;\n+const d = 4;\n+const e = 5;",
        },
      ],
      totals: { additions: 5, deletions: 0, changedFiles: 1 },
    };

    await synthesizeModule.runChunkedReview(stub, { intent, diff });

    const sizeLogs = (infoSpy.mock.calls as unknown[][]).filter(
      (call) => (call[1] as Record<string, unknown>)?.evt === "prompt.size",
    );

    // There should be at least one prompt.size log (from pass-2).
    expect(sizeLogs.length).toBeGreaterThanOrEqual(1);
    const chunkedLog = sizeLogs.find(
      (call) => (call[1] as Record<string, unknown>)?.mode === "chunked",
    );
    expect(chunkedLog).toBeDefined();
    const fields = chunkedLog![1] as Record<string, unknown>;
    expect(fields.repo).toBe("acme/widget");
    expect(fields.pr).toBe(42);
  });
});
