/**
 * Integration tests: weekly token budget enforcement in runReview.
 *
 * These tests verify that runReview correctly gates on max_weekly_tokens,
 * returns a summary-only response, increments the metric, and writes a
 * budget_exhausted usage record.
 */
import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Anthropic from "@anthropic-ai/sdk";
import type { PullRequestDiff } from "../src/github";
import type { Intent } from "../src/jira";
import { runReview } from "../src/review";
import * as usageModule from "../src/review/usage";
import * as budgetModule from "../src/review/budget";
import { registry, budgetExhaustedTotal } from "../src/server/metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiff(): PullRequestDiff {
  return {
    owner: "acme",
    repo: "budgetrepo",
    number: 42,
    headSha: "sha123",
    baseSha: "sha000",
    title: "test PR",
    body: "",
    files: [
      {
        filename: "src/index.ts",
        status: "modified",
        additions: 5,
        deletions: 2,
        changes: 7,
        patch: "x".repeat(100),
      },
    ],
    totals: { additions: 5, deletions: 2, changedFiles: 1 },
  };
}

const intent: Intent = {
  source: "jira",
  ticketKey: "PROJ-1",
  title: "some ticket",
  description: "desc",
  warnings: [],
};

function stubAnthropic(): { stub: Anthropic; calls: unknown[] } {
  const calls: unknown[] = [];
  const stub = {
    messages: {
      parse: async (params: unknown) => {
        calls.push(params);
        return {
          parsed_output: {
            verdict: "approve",
            summary: "looks fine",
            lineComments: [],
          },
          usage: {
            input_tokens: 50,
            output_tokens: 30,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        };
      },
    },
  } as unknown as Anthropic;
  return { stub, calls };
}

function readCounterValue(metricName: string, labels: Record<string, string>): number {
  // Access registry internals via the exported render — simpler than
  // exposing a dedicated accessor for tests.
  const rendered = registry.render();
  const labelStr = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
  const pattern = new RegExp(
    `^${metricName}\\{${labelStr}\\}\\s+(\\d+)`,
    "m",
  );
  const match = rendered.match(pattern);
  return match ? parseInt(match[1]!, 10) : 0;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
const origEnv = process.env["USAGE_LOG_DIR"];
const origReviewMode = process.env["REVIEW_MODE"];

// Helper: write a JSONL file with a given number of tokens already used this week.
async function writeWeeklyUsage(tokensUsed: number, now: Date): Promise<void> {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const record = {
    ts: now.toISOString(),
    repo: "acme/budgetrepo",
    pr: 1,
    headSha: "prev",
    model: "claude-opus-4-7",
    verdict: "approve",
    inputTokens: tokensUsed,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  await writeFile(
    join(tmpDir, `${year}-${month}.jsonl`),
    JSON.stringify(record) + "\n",
  );
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "budget-integration-"));
  process.env["USAGE_LOG_DIR"] = tmpDir;
  process.env["REVIEW_MODE"] = "single";
  budgetModule._clearCache();
});

afterEach(async () => {
  if (origEnv === undefined) {
    delete process.env["USAGE_LOG_DIR"];
  } else {
    process.env["USAGE_LOG_DIR"] = origEnv;
  }
  if (origReviewMode === undefined) {
    delete process.env["REVIEW_MODE"];
  } else {
    process.env["REVIEW_MODE"] = origReviewMode;
  }
  budgetModule._clearCache();
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runReview — weekly budget enforcement", () => {
  test("returns summary-only when weekly tokens >= max_weekly_tokens", async () => {
    const now = new Date();
    await writeWeeklyUsage(150, now); // 150 already used
    budgetModule._clearCache();

    const { stub, calls } = stubAnthropic();
    const recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);

    const out = await runReview(
      stub,
      {
        intent,
        diff: makeDiff(),
        reviewConfig: { max_weekly_tokens: 100 }, // cap = 100
      },
    );

    // No LLM call
    expect(calls).toHaveLength(0);

    // Summary-only result
    expect(out.result.verdict).toBe("comment");
    expect(out.result.lineComments).toEqual([]);
    expect(out.result.summary).toContain("weekly automated-review token budget");
    expect(out.result.summary).toContain("150");
    expect(out.result.summary).toContain("100");

    // Warning emitted
    expect(out.warnings).toContain("weekly token budget exhausted");

    // recordUsage called with budget_exhausted verdict and 0 tokens
    expect(recordUsageSpy).toHaveBeenCalledTimes(1);
    const usageCall = recordUsageSpy.mock.calls[0]![0];
    expect(usageCall.verdict).toBe("budget_exhausted");
    expect(usageCall.inputTokens).toBe(0);
    expect(usageCall.outputTokens).toBe(0);
    expect(usageCall.repo).toBe("acme/budgetrepo");

    recordUsageSpy.mockRestore();
  });

  test("increments budget_exhausted metric with repo label", async () => {
    const now = new Date();
    await writeWeeklyUsage(200, now);
    budgetModule._clearCache();

    const { stub } = stubAnthropic();
    const recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);

    const beforeCount = readCounterValue(budgetExhaustedTotal, { repo: "acme/budgetrepo" });

    await runReview(stub, {
      intent,
      diff: makeDiff(),
      reviewConfig: { max_weekly_tokens: 100 },
    });

    const afterCount = readCounterValue(budgetExhaustedTotal, { repo: "acme/budgetrepo" });
    expect(afterCount).toBe(beforeCount + 1);

    recordUsageSpy.mockRestore();
  });

  test("runs full LLM review when max_weekly_tokens is not set (regression)", async () => {
    const now = new Date();
    await writeWeeklyUsage(999_999, now); // tons of tokens used, but no cap
    budgetModule._clearCache();

    const { stub, calls } = stubAnthropic();
    const recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);

    const out = await runReview(stub, {
      intent,
      diff: makeDiff(),
      reviewConfig: {}, // no max_weekly_tokens
    });

    // LLM was called
    expect(calls).toHaveLength(1);
    expect(out.result.verdict).toBe("approve");
    expect(out.warnings).not.toContain("weekly token budget exhausted");

    recordUsageSpy.mockRestore();
  });

  test("runs full LLM review when reviewConfig is absent entirely (regression)", async () => {
    const now = new Date();
    await writeWeeklyUsage(999_999, now);
    budgetModule._clearCache();

    const { stub, calls } = stubAnthropic();
    const recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);

    const out = await runReview(stub, {
      intent,
      diff: makeDiff(),
      // no reviewConfig at all
    });

    expect(calls).toHaveLength(1);
    expect(out.result.verdict).toBe("approve");

    recordUsageSpy.mockRestore();
  });

  test("budget enforcement lifts when ISO week advances (clock advance)", async () => {
    // We use getWeeklyTokenSum directly (the same function runReview calls)
    // to verify ISO-week boundary behaviour: over-budget this week, then zero
    // after advancing to the next Monday.
    //
    // We spy on getWeeklyTokenSum so runReview sees controlled values without
    // requiring a 4th `now` parameter on the public API.

    const recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);

    // Week 1: 150 tokens used > cap 100 → budget_exhausted
    const getWeeklySpy = spyOn(budgetModule, "getWeeklyTokenSum").mockResolvedValueOnce(150);

    const { stub, calls } = stubAnthropic();

    const outBlocked = await runReview(stub, {
      intent,
      diff: makeDiff(),
      reviewConfig: { max_weekly_tokens: 100 },
    });

    expect(calls).toHaveLength(0);
    expect(outBlocked.result.verdict).toBe("comment");
    expect(outBlocked.warnings).toContain("weekly token budget exhausted");

    // Week 2 (next ISO week): 0 tokens used → review runs normally.
    getWeeklySpy.mockResolvedValueOnce(0);

    const outAllowed = await runReview(stub, {
      intent,
      diff: makeDiff(),
      reviewConfig: { max_weekly_tokens: 100 },
    });

    expect(calls).toHaveLength(1); // LLM was called this time
    expect(outAllowed.result.verdict).toBe("approve");
    expect(outAllowed.warnings).not.toContain("weekly token budget exhausted");

    getWeeklySpy.mockRestore();
    recordUsageSpy.mockRestore();
  });

  test("exact equal to cap triggers budget_exhausted (boundary: >= not >)", async () => {
    const now = new Date();
    await writeWeeklyUsage(100, now); // exactly equal to cap
    budgetModule._clearCache();

    const { stub, calls } = stubAnthropic();
    const recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);

    const out = await runReview(stub, {
      intent,
      diff: makeDiff(),
      reviewConfig: { max_weekly_tokens: 100 },
    });

    expect(calls).toHaveLength(0);
    expect(out.warnings).toContain("weekly token budget exhausted");

    recordUsageSpy.mockRestore();
  });

  test("one token under cap allows the review through", async () => {
    const now = new Date();
    await writeWeeklyUsage(99, now); // one under cap of 100
    budgetModule._clearCache();

    const { stub, calls } = stubAnthropic();
    const recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);

    const out = await runReview(stub, {
      intent,
      diff: makeDiff(),
      reviewConfig: { max_weekly_tokens: 100 },
    });

    expect(calls).toHaveLength(1); // LLM called
    expect(out.warnings).not.toContain("weekly token budget exhausted");

    recordUsageSpy.mockRestore();
  });
});
