/**
 * Tests for the large-PR warning metric and log (issue #81).
 *
 * Strategy: spy on log.info and the metrics registry to observe side-effects
 * without invoking an actual LLM. We stub the Anthropic client just enough for
 * runReview to complete the single-pass path.
 *
 * Env-override tests mutate `largePrThresholds` directly (the exported object)
 * so no process restarts are needed — this mirrors the module-load pattern and
 * lets tests override thresholds without env var gymnastics.
 */

import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { PullRequestDiff } from "../src/github";
import type { Intent } from "../src/jira";
import { runReview } from "../src/review";
import { resultCache } from "../src/review/result-cache";
import { largePrThresholds } from "../src/review/large-pr-thresholds";
import * as metricsModule from "../src/server/metrics";
import * as loggerModule from "../src/server/logger";
import * as usageModule from "../src/review/usage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const intent: Intent = {
  source: "pr-body",
  title: "test PR",
  description: "test",
  warnings: [],
};

/**
 * Build a PullRequestDiff with `fileCount` files, each having `additionsPerFile`
 * additions and `deletionsPerFile` deletions. Patch is minimal to stay under
 * maxDiffChars so single-pass path is exercised (no chunking).
 */
function makeDiff(opts: {
  fileCount: number;
  additionsPerFile?: number;
  deletionsPerFile?: number;
}): PullRequestDiff {
  const { fileCount, additionsPerFile = 1, deletionsPerFile = 0 } = opts;
  const files = Array.from({ length: fileCount }, (_, i) => ({
    filename: `src/file${i}.ts`,
    status: "modified" as const,
    additions: additionsPerFile,
    deletions: deletionsPerFile,
    changes: additionsPerFile + deletionsPerFile,
    patch: `+line ${i}`,
  }));

  return {
    owner: "acme",
    repo: "widget",
    number: 1,
    headSha: `sha-${fileCount}-${additionsPerFile}-${deletionsPerFile}`,
    baseSha: "base",
    title: "test PR",
    body: "body",
    files,
    totals: {
      additions: fileCount * additionsPerFile,
      deletions: fileCount * deletionsPerFile,
      changedFiles: fileCount,
    },
  };
}

function stubAnthropicOk(): Anthropic {
  return {
    messages: {
      parse: async () => ({
        parsed_output: {
          verdict: "approve",
          summary: "looks good",
          lineComments: [],
        },
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    },
  } as unknown as Anthropic;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("large-PR warning", () => {
  let incLargePrSpy: ReturnType<typeof spyOn<typeof metricsModule, "incLargePr">>;
  let logInfoSpy: ReturnType<typeof spyOn>;
  let recordUsageSpy: ReturnType<typeof spyOn>;
  // Save original threshold values so we can restore them after each test.
  let savedFiles: number;
  let savedLoc: number;

  beforeEach(() => {
    resultCache.clear();
    savedFiles = largePrThresholds.files;
    savedLoc = largePrThresholds.loc;
    incLargePrSpy = spyOn(metricsModule, "incLargePr");
    logInfoSpy = spyOn(loggerModule.log, "info");
    recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);
  });

  afterEach(() => {
    largePrThresholds.files = savedFiles;
    largePrThresholds.loc = savedLoc;
    incLargePrSpy.mockRestore();
    logInfoSpy.mockRestore();
    recordUsageSpy.mockRestore();
    resultCache.clear();
  });

  // -------------------------------------------------------------------------
  // files threshold exceeded
  // -------------------------------------------------------------------------

  test("60 kept files → reason=files, log emitted", async () => {
    const diff = makeDiff({ fileCount: 60, additionsPerFile: 1, deletionsPerFile: 0 });
    await runReview(stubAnthropicOk(), { intent, diff });

    expect(incLargePrSpy).toHaveBeenCalledTimes(1);
    expect(incLargePrSpy).toHaveBeenCalledWith("files");

    // Verify log call: find the review.large_pr event
    const logCalls: unknown[][] = (logInfoSpy as { mock: { calls: unknown[][] } }).mock.calls;
    const largePrLog = logCalls.find(
      (args) => args[0] === "review.large_pr",
    );
    expect(largePrLog).toBeDefined();
    const payload = largePrLog![1] as Record<string, unknown>;
    expect(payload["evt"]).toBe("review.large_pr");
    expect(payload["kept_files"]).toBe(60);
    expect((payload["exceeds"] as string[])).toContain("files");
    expect((payload["exceeds"] as string[])).not.toContain("loc");
  });

  // -------------------------------------------------------------------------
  // loc threshold exceeded
  // -------------------------------------------------------------------------

  test("3500 total LoC → reason=loc, log emitted", async () => {
    // 10 files × (200 additions + 150 deletions) = 10 × 350 = 3500 LoC total
    const diff = makeDiff({ fileCount: 10, additionsPerFile: 200, deletionsPerFile: 150 });
    await runReview(stubAnthropicOk(), { intent, diff });

    expect(incLargePrSpy).toHaveBeenCalledTimes(1);
    expect(incLargePrSpy).toHaveBeenCalledWith("loc");

    const logCalls: unknown[][] = (logInfoSpy as { mock: { calls: unknown[][] } }).mock.calls;
    const largePrLog = logCalls.find((args) => args[0] === "review.large_pr");
    expect(largePrLog).toBeDefined();
    const payload = largePrLog![1] as Record<string, unknown>;
    expect(payload["evt"]).toBe("review.large_pr");
    // added_loc + deleted_loc should equal 3500
    const totalLoc =
      (payload["added_loc"] as number) + (payload["deleted_loc"] as number);
    expect(totalLoc).toBe(3500);
    expect((payload["exceeds"] as string[])).toContain("loc");
    expect((payload["exceeds"] as string[])).not.toContain("files");
  });

  // -------------------------------------------------------------------------
  // both thresholds exceeded
  // -------------------------------------------------------------------------

  test("60 files + 3500 LoC → reason=both, log emitted", async () => {
    // 60 files × (40 additions + 20 deletions) = 60 × 60 = 3600 LoC total
    const diff = makeDiff({ fileCount: 60, additionsPerFile: 40, deletionsPerFile: 20 });
    await runReview(stubAnthropicOk(), { intent, diff });

    expect(incLargePrSpy).toHaveBeenCalledTimes(1);
    expect(incLargePrSpy).toHaveBeenCalledWith("both");

    const logCalls: unknown[][] = (logInfoSpy as { mock: { calls: unknown[][] } }).mock.calls;
    const largePrLog = logCalls.find((args) => args[0] === "review.large_pr");
    expect(largePrLog).toBeDefined();
    const payload = largePrLog![1] as Record<string, unknown>;
    expect(payload["exceeds"]).toEqual(["files", "loc"]);
  });

  // -------------------------------------------------------------------------
  // neither threshold exceeded — no emission
  // -------------------------------------------------------------------------

  test("small PR (5 files, 100 LoC) → no metric, no large_pr log", async () => {
    const diff = makeDiff({ fileCount: 5, additionsPerFile: 10, deletionsPerFile: 10 });
    await runReview(stubAnthropicOk(), { intent, diff });

    expect(incLargePrSpy).not.toHaveBeenCalled();

    const logCalls: unknown[][] = (logInfoSpy as { mock: { calls: unknown[][] } }).mock.calls;
    const largePrLog = logCalls.find((args) => args[0] === "review.large_pr");
    expect(largePrLog).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // env-override: lower the file threshold so 10 files triggers it
  // -------------------------------------------------------------------------

  test("env override: LARGE_PR_FILES_THRESHOLD=5 → 10 files triggers files warning", async () => {
    largePrThresholds.files = 5;

    const diff = makeDiff({ fileCount: 10, additionsPerFile: 1, deletionsPerFile: 0 });
    await runReview(stubAnthropicOk(), { intent, diff });

    expect(incLargePrSpy).toHaveBeenCalledWith("files");
  });

  // -------------------------------------------------------------------------
  // env-override: lower the LoC threshold so 100 LoC triggers it
  // -------------------------------------------------------------------------

  test("env override: LARGE_PR_LOC_THRESHOLD=50 → 100 LoC triggers loc warning", async () => {
    largePrThresholds.loc = 50;

    // 5 files × (10 additions + 10 deletions) = 100 LoC total; file count still under default
    const diff = makeDiff({ fileCount: 5, additionsPerFile: 10, deletionsPerFile: 10 });
    await runReview(stubAnthropicOk(), { intent, diff });

    expect(incLargePrSpy).toHaveBeenCalledWith("loc");
  });
});
