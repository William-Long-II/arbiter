import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  aggregateRecords,
  estimateCost,
  recordUsage,
  type UsageRecord,
} from "../src/review/usage";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const JAN_RECORDS: UsageRecord[] = [
  {
    ts: "2024-01-10T10:00:00.000Z",
    repo: "acme/alpha",
    pr: 1,
    headSha: "aaa",
    model: "claude-opus-4-7",
    verdict: "approve",
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 500,
  },
  {
    ts: "2024-01-15T12:00:00.000Z",
    repo: "acme/alpha",
    pr: 2,
    headSha: "bbb",
    model: "claude-opus-4-7",
    verdict: "comment",
    inputTokens: 2000,
    outputTokens: 400,
    cacheReadTokens: 100,
    cacheCreationTokens: 0,
  },
  {
    ts: "2024-01-20T08:00:00.000Z",
    repo: "acme/beta",
    pr: 10,
    headSha: "ccc",
    model: "claude-opus-4-7",
    verdict: "too_large",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
];

const FEB_RECORDS: UsageRecord[] = [
  {
    ts: "2024-02-05T09:00:00.000Z",
    repo: "acme/alpha",
    pr: 3,
    headSha: "ddd",
    model: "claude-opus-4-7",
    verdict: "approve",
    inputTokens: 1500,
    outputTokens: 300,
    cacheReadTokens: 200,
    cacheCreationTokens: 0,
  },
  {
    ts: "2024-02-12T14:00:00.000Z",
    repo: "acme/gamma",
    pr: 1,
    headSha: "eee",
    model: "claude-opus-4-7",
    verdict: "comment",
    inputTokens: 3000,
    outputTokens: 600,
    cacheReadTokens: 0,
    cacheCreationTokens: 1000,
  },
];

const ALL_RECORDS = [...JAN_RECORDS, ...FEB_RECORDS];

// ---------------------------------------------------------------------------
// aggregateRecords
// ---------------------------------------------------------------------------

describe("aggregateRecords", () => {
  test("groups records by repo and sums token counts", () => {
    const aggs = aggregateRecords(ALL_RECORDS);

    expect(aggs.map((a) => a.repo)).toEqual(["acme/alpha", "acme/beta", "acme/gamma"]);

    const alpha = aggs.find((a) => a.repo === "acme/alpha")!;
    expect(alpha.reviews).toBe(3);
    expect(alpha.inputTokens).toBe(1000 + 2000 + 1500);
    expect(alpha.outputTokens).toBe(200 + 400 + 300);
    expect(alpha.cacheReadTokens).toBe(0 + 100 + 200);
    expect(alpha.cacheCreationTokens).toBe(500 + 0 + 0);
  });

  test("includes too_large records with zero tokens", () => {
    const aggs = aggregateRecords(ALL_RECORDS);
    const beta = aggs.find((a) => a.repo === "acme/beta")!;
    expect(beta.reviews).toBe(1);
    expect(beta.inputTokens).toBe(0);
    expect(beta.outputTokens).toBe(0);
    expect(beta.estimatedCostUsd).toBe(0);
  });

  test("filters records by since date", () => {
    const since = new Date("2024-02-01T00:00:00.000Z");
    const aggs = aggregateRecords(ALL_RECORDS, since);

    // Only Feb records survive the filter
    expect(aggs.map((a) => a.repo)).toEqual(["acme/alpha", "acme/gamma"]);

    const alpha = aggs.find((a) => a.repo === "acme/alpha")!;
    expect(alpha.reviews).toBe(1);
    expect(alpha.inputTokens).toBe(1500);
  });

  test("--since 7d window excludes records older than 7 days", () => {
    // Build records: one from 10 days ago, one from 3 days ago
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

    const records: UsageRecord[] = [
      {
        ts: tenDaysAgo.toISOString(),
        repo: "acme/old",
        pr: 1,
        headSha: "old",
        model: "claude-opus-4-7",
        verdict: "approve",
        inputTokens: 9999,
        outputTokens: 9999,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      {
        ts: threeDaysAgo.toISOString(),
        repo: "acme/recent",
        pr: 2,
        headSha: "new",
        model: "claude-opus-4-7",
        verdict: "approve",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ];

    // Compute "since" the same way the script does: midnight 7 days ago
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - 7);
    since.setUTCHours(0, 0, 0, 0);

    const aggs = aggregateRecords(records, since);
    expect(aggs.map((a) => a.repo)).toEqual(["acme/recent"]);
    expect(aggs[0]?.inputTokens).toBe(100);
  });

  test("returns empty array for empty input", () => {
    expect(aggregateRecords([])).toEqual([]);
  });

  test("returns empty array when all records are filtered out by since", () => {
    const future = new Date("2099-01-01T00:00:00.000Z");
    expect(aggregateRecords(ALL_RECORDS, future)).toEqual([]);
  });

  test("results are sorted alphabetically by repo", () => {
    const mixed = [...FEB_RECORDS, ...JAN_RECORDS];
    const aggs = aggregateRecords(mixed);
    const repos = aggs.map((a) => a.repo);
    expect(repos).toEqual([...repos].sort());
  });
});

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

describe("estimateCost", () => {
  test("computes cost for claude-opus-4-7", () => {
    const cost = estimateCost({
      model: "claude-opus-4-7",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    // $15 input + $75 output = $90
    expect(cost).toBeCloseTo(90, 5);
  });

  test("returns 0 for unknown model", () => {
    const cost = estimateCost({
      model: "unknown-model",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(cost).toBe(0);
  });

  test("returns 0 for zero tokens", () => {
    const cost = estimateCost({
      model: "claude-opus-4-7",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(cost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// recordUsage (integration — writes to a temp dir)
// ---------------------------------------------------------------------------

describe("recordUsage", () => {
  let tmpDir: string;
  const origEnv = process.env["USAGE_LOG_DIR"];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "usage-test-"));
    process.env["USAGE_LOG_DIR"] = tmpDir;
  });

  afterEach(async () => {
    if (origEnv === undefined) {
      delete process.env["USAGE_LOG_DIR"];
    } else {
      process.env["USAGE_LOG_DIR"] = origEnv;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("writes a JSONL record to the monthly file", async () => {
    const before = new Date();
    await recordUsage({
      repo: "acme/widget",
      pr: 42,
      headSha: "deadbeef",
      model: "claude-opus-4-7",
      verdict: "approve",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 100,
    });

    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const filePath = join(tmpDir, `${monthKey}.jsonl`);

    const content = await Bun.file(filePath).text();
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!) as UsageRecord;
    expect(record.repo).toBe("acme/widget");
    expect(record.pr).toBe(42);
    expect(record.headSha).toBe("deadbeef");
    expect(record.model).toBe("claude-opus-4-7");
    expect(record.verdict).toBe("approve");
    expect(record.inputTokens).toBe(1000);
    expect(record.outputTokens).toBe(200);
    expect(record.cacheReadTokens).toBe(50);
    expect(record.cacheCreationTokens).toBe(100);

    const ts = new Date(record.ts);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100);
    expect(ts.getTime()).toBeLessThanOrEqual(now.getTime() + 100);
  });

  test("appends multiple records to the same file", async () => {
    await recordUsage({
      repo: "acme/widget",
      pr: 1,
      headSha: "aaa",
      model: "claude-opus-4-7",
      verdict: "approve",
      inputTokens: 100,
      outputTokens: 50,
    });
    await recordUsage({
      repo: "acme/widget",
      pr: 2,
      headSha: "bbb",
      model: "claude-opus-4-7",
      verdict: "comment",
      inputTokens: 200,
      outputTokens: 100,
    });

    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const filePath = join(tmpDir, `${monthKey}.jsonl`);

    const content = await Bun.file(filePath).text();
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  test("records too_large verdict with zero tokens", async () => {
    await recordUsage({
      repo: "acme/huge",
      pr: 99,
      headSha: "fff",
      model: "claude-opus-4-7",
      verdict: "too_large",
      inputTokens: 0,
      outputTokens: 0,
    });

    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const filePath = join(tmpDir, `${monthKey}.jsonl`);

    const content = await Bun.file(filePath).text();
    const record = JSON.parse(content.trim()) as UsageRecord;
    expect(record.verdict).toBe("too_large");
    expect(record.inputTokens).toBe(0);
    expect(record.outputTokens).toBe(0);
  });

  test("creates the log directory if it does not exist", async () => {
    const nestedDir = join(tmpDir, "nested", "deep");
    process.env["USAGE_LOG_DIR"] = nestedDir;

    await recordUsage({
      repo: "acme/widget",
      pr: 1,
      headSha: "aaa",
      model: "claude-opus-4-7",
      verdict: "approve",
      inputTokens: 10,
      outputTokens: 5,
    });

    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const filePath = join(nestedDir, `${monthKey}.jsonl`);
    const content = await Bun.file(filePath).text();
    expect(content.trim().length).toBeGreaterThan(0);
  });
});
