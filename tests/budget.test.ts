import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getWeeklyTokenSum,
  _clearCache,
  _setNowMs,
} from "../src/review/budget";
import type { UsageRecord } from "../src/review/usage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a Monday in UTC for the given ISO date string. */
function monday(isoDate: string): Date {
  const d = new Date(isoDate + "T00:00:00.000Z");
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  expect(dow).toBe(1); // sanity-check: must actually be a Monday
  return d;
}

function makeRecord(partial: Partial<UsageRecord> & { ts: string; repo: string }): UsageRecord {
  return {
    pr: 1,
    headSha: "abc",
    model: "claude-opus-4-7",
    verdict: "approve",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...partial,
  };
}

function toJsonl(records: UsageRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let tmpDir: string;
const origEnv = process.env["USAGE_LOG_DIR"];

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "budget-test-"));
  process.env["USAGE_LOG_DIR"] = tmpDir;
  _clearCache();
  // Reset clock to real time between tests
  _setNowMs(() => Date.now());
});

afterEach(async () => {
  if (origEnv === undefined) {
    delete process.env["USAGE_LOG_DIR"];
  } else {
    process.env["USAGE_LOG_DIR"] = origEnv;
  }
  _clearCache();
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Week used: 2024-04-15 (Mon) to 2024-04-21 (Sun)
// ---------------------------------------------------------------------------

const WEEK_MON = "2024-04-15T00:00:00.000Z";
const WEEK_WED = "2024-04-17T10:00:00.000Z";
const WEEK_SUN = "2024-04-21T23:59:59.000Z";
const PREV_WEEK_SUN = "2024-04-14T23:59:59.000Z"; // Sunday before our week
const NEXT_WEEK_MON = "2024-04-22T00:00:00.000Z"; // Monday of next week

describe("getWeeklyTokenSum — basic sum", () => {
  test("sums inputTokens + outputTokens for matching repo in current week", async () => {
    const records: UsageRecord[] = [
      makeRecord({ ts: WEEK_WED, repo: "acme/widget", inputTokens: 100, outputTokens: 50 }),
      makeRecord({ ts: WEEK_MON, repo: "acme/widget", inputTokens: 200, outputTokens: 75 }),
    ];
    await writeFile(join(tmpDir, "2024-04.jsonl"), toJsonl(records));

    const now = new Date(WEEK_WED);
    const sum = await getWeeklyTokenSum("acme/widget", now);
    expect(sum).toBe(100 + 50 + 200 + 75); // 425
  });

  test("excludes records for other repos", async () => {
    const records: UsageRecord[] = [
      makeRecord({ ts: WEEK_WED, repo: "acme/widget", inputTokens: 100, outputTokens: 50 }),
      makeRecord({ ts: WEEK_WED, repo: "acme/other", inputTokens: 9999, outputTokens: 9999 }),
    ];
    await writeFile(join(tmpDir, "2024-04.jsonl"), toJsonl(records));

    const sum = await getWeeklyTokenSum("acme/widget", new Date(WEEK_WED));
    expect(sum).toBe(150);
  });

  test("repo matching is case-insensitive", async () => {
    const records: UsageRecord[] = [
      makeRecord({ ts: WEEK_WED, repo: "Acme/Widget", inputTokens: 300, outputTokens: 0 }),
    ];
    await writeFile(join(tmpDir, "2024-04.jsonl"), toJsonl(records));

    const sum = await getWeeklyTokenSum("acme/widget", new Date(WEEK_WED));
    expect(sum).toBe(300);
  });
});

describe("getWeeklyTokenSum — week boundary exclusions", () => {
  test("excludes record on Sunday just before the current ISO week started", async () => {
    const records: UsageRecord[] = [
      makeRecord({ ts: PREV_WEEK_SUN, repo: "acme/widget", inputTokens: 500, outputTokens: 0 }),
      makeRecord({ ts: WEEK_MON, repo: "acme/widget", inputTokens: 100, outputTokens: 0 }),
    ];
    await writeFile(join(tmpDir, "2024-04.jsonl"), toJsonl(records));

    const sum = await getWeeklyTokenSum("acme/widget", new Date(WEEK_WED));
    expect(sum).toBe(100); // only the Monday record counts
  });

  test("excludes record on Monday of the next ISO week", async () => {
    const records: UsageRecord[] = [
      makeRecord({ ts: WEEK_SUN, repo: "acme/widget", inputTokens: 100, outputTokens: 0 }),
      makeRecord({ ts: NEXT_WEEK_MON, repo: "acme/widget", inputTokens: 999, outputTokens: 0 }),
    ];
    await writeFile(join(tmpDir, "2024-04.jsonl"), toJsonl(records));

    const sum = await getWeeklyTokenSum("acme/widget", new Date(WEEK_SUN));
    expect(sum).toBe(100); // only the Sunday record counts
  });

  test("includes record on the Monday boundary (first ms of week)", async () => {
    const records: UsageRecord[] = [
      makeRecord({ ts: WEEK_MON, repo: "acme/widget", inputTokens: 42, outputTokens: 0 }),
    ];
    await writeFile(join(tmpDir, "2024-04.jsonl"), toJsonl(records));

    const sum = await getWeeklyTokenSum("acme/widget", new Date(WEEK_MON));
    expect(sum).toBe(42);
  });
});

describe("getWeeklyTokenSum — month boundary (reads two files)", () => {
  // 2024-07-01 is a Monday. The ISO week containing 2024-07-03 (Wed) starts
  // on 2024-07-01 (Mon). No previous-month file is needed here.
  // For the cross-boundary case: 2024-04-01 is a Monday.
  // The ISO week containing 2024-04-03 (Wed) starts Mon 2024-04-01.
  // So tokens from 2024-03-31 (Sun of previous week) should NOT be included,
  // but tokens from 2024-04-01 should be included.

  test("reads previous month file when ISO week started in prior month", async () => {
    // 2024-04-01 is a Monday → week starts that day.
    // Let's use a Wednesday in week starting 2024-04-01.
    // To force a cross-month scenario let's pick 2024-05-01 (Wednesday).
    // ISO week: Mon 2024-04-29 → Sun 2024-05-05.
    const weekMon = "2024-04-29T00:00:00.000Z"; // Monday in April
    const wedMay = "2024-05-01T12:00:00.000Z"; // Wednesday in May (same ISO week)

    const aprilRecords: UsageRecord[] = [
      makeRecord({ ts: weekMon, repo: "acme/widget", inputTokens: 300, outputTokens: 0 }),
    ];
    const mayRecords: UsageRecord[] = [
      makeRecord({ ts: wedMay, repo: "acme/widget", inputTokens: 200, outputTokens: 0 }),
    ];

    await writeFile(join(tmpDir, "2024-04.jsonl"), toJsonl(aprilRecords));
    await writeFile(join(tmpDir, "2024-05.jsonl"), toJsonl(mayRecords));

    // "now" is Wednesday 2024-05-01
    const sum = await getWeeklyTokenSum("acme/widget", new Date(wedMay));
    expect(sum).toBe(500); // April Monday + May Wednesday both in same ISO week
  });

  test("does not double-count when week is entirely within one month", async () => {
    const records: UsageRecord[] = [
      makeRecord({ ts: WEEK_WED, repo: "acme/widget", inputTokens: 100, outputTokens: 50 }),
    ];
    await writeFile(join(tmpDir, "2024-04.jsonl"), toJsonl(records));

    const sum = await getWeeklyTokenSum("acme/widget", new Date(WEEK_WED));
    expect(sum).toBe(150);
  });
});

describe("getWeeklyTokenSum — missing file returns 0", () => {
  test("returns 0 when no file exists for the month", async () => {
    const sum = await getWeeklyTokenSum("acme/widget", new Date(WEEK_WED));
    expect(sum).toBe(0);
  });

  test("returns sum of remaining month even if previous month file is missing", async () => {
    // Week spans April→May boundary; only May file exists.
    const wedMay = "2024-05-01T12:00:00.000Z";
    const mayRecords: UsageRecord[] = [
      makeRecord({ ts: wedMay, repo: "acme/widget", inputTokens: 77, outputTokens: 0 }),
    ];
    await writeFile(join(tmpDir, "2024-05.jsonl"), toJsonl(mayRecords));

    const sum = await getWeeklyTokenSum("acme/widget", new Date(wedMay));
    expect(sum).toBe(77);
  });
});

describe("getWeeklyTokenSum — invalid JSONL lines are skipped", () => {
  test("skips unparseable lines and still sums valid ones", async () => {
    const valid = makeRecord({ ts: WEEK_WED, repo: "acme/widget", inputTokens: 50, outputTokens: 25 });
    const content = `${JSON.stringify(valid)}\nnot-valid-json\n{"incomplete":true\n`;
    await writeFile(join(tmpDir, "2024-04.jsonl"), content);

    const sum = await getWeeklyTokenSum("acme/widget", new Date(WEEK_WED));
    expect(sum).toBe(75);
  });

  test("skips records with invalid ts field", async () => {
    const badTs = makeRecord({ ts: "not-a-date", repo: "acme/widget", inputTokens: 999, outputTokens: 0 });
    const goodRecord = makeRecord({ ts: WEEK_WED, repo: "acme/widget", inputTokens: 10, outputTokens: 0 });
    await writeFile(join(tmpDir, "2024-04.jsonl"), toJsonl([badTs, goodRecord]));

    const sum = await getWeeklyTokenSum("acme/widget", new Date(WEEK_WED));
    expect(sum).toBe(10);
  });

  test("handles empty file gracefully", async () => {
    await writeFile(join(tmpDir, "2024-04.jsonl"), "");
    const sum = await getWeeklyTokenSum("acme/widget", new Date(WEEK_WED));
    expect(sum).toBe(0);
  });
});

describe("getWeeklyTokenSum — cache", () => {
  test("returns cached value within 60 seconds without re-reading the file", async () => {
    const records: UsageRecord[] = [
      makeRecord({ ts: WEEK_WED, repo: "acme/widget", inputTokens: 100, outputTokens: 0 }),
    ];
    await writeFile(join(tmpDir, "2024-04.jsonl"), toJsonl(records));

    const nowBase = new Date(WEEK_WED).getTime();
    _setNowMs(() => nowBase);

    const sum1 = await getWeeklyTokenSum("acme/widget", new Date(WEEK_WED));
    expect(sum1).toBe(100);

    // Overwrite the file with different data — cache should still serve old value
    const newRecords: UsageRecord[] = [
      makeRecord({ ts: WEEK_WED, repo: "acme/widget", inputTokens: 9999, outputTokens: 0 }),
    ];
    await writeFile(join(tmpDir, "2024-04.jsonl"), toJsonl(newRecords));

    // Advance clock by 30 seconds — still within TTL
    _setNowMs(() => nowBase + 30_000);

    const sum2 = await getWeeklyTokenSum("acme/widget", new Date(WEEK_WED));
    expect(sum2).toBe(100); // stale cache value
  });

  test("re-reads file after cache expires (>60s)", async () => {
    const records: UsageRecord[] = [
      makeRecord({ ts: WEEK_WED, repo: "acme/widget", inputTokens: 100, outputTokens: 0 }),
    ];
    await writeFile(join(tmpDir, "2024-04.jsonl"), toJsonl(records));

    const nowBase = new Date(WEEK_WED).getTime();
    _setNowMs(() => nowBase);

    const sum1 = await getWeeklyTokenSum("acme/widget", new Date(WEEK_WED));
    expect(sum1).toBe(100);

    // Update the file
    const newRecords: UsageRecord[] = [
      makeRecord({ ts: WEEK_WED, repo: "acme/widget", inputTokens: 9999, outputTokens: 0 }),
    ];
    await writeFile(join(tmpDir, "2024-04.jsonl"), toJsonl(newRecords));

    // Advance clock beyond 60 second TTL
    _setNowMs(() => nowBase + 61_000);

    const sum2 = await getWeeklyTokenSum("acme/widget", new Date(WEEK_WED));
    expect(sum2).toBe(9999); // fresh read
  });
});
