/**
 * Per-repo weekly token budget helpers.
 *
 * ISO weeks run Mon 00:00:00 UTC → Sun 23:59:59.999 UTC. We use UTC throughout
 * so the rollover is independent of the server's local timezone — operators in
 * different timezones see consistent behaviour.
 *
 * We scan the current month's JSONL file AND the previous month's file because
 * a Monday that starts a new ISO week may fall in the first day of a new
 * calendar month (e.g. 2024-04-01 is a Monday). Without reading the previous
 * month we would miss tokens spent in the last few days of March that belong
 * to the same ISO week.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../server/logger";
import type { UsageRecord } from "./usage";

// ---------------------------------------------------------------------------
// ISO week helpers
// ---------------------------------------------------------------------------

/**
 * Returns the UTC timestamp (ms) of Monday 00:00:00.000 UTC for the ISO week
 * containing `date`.
 *
 * ISO 8601 weeks start on Monday. getUTCDay() returns 0 for Sunday, so we
 * map Sunday to 7 to make the arithmetic uniform (Mon=1, …, Sun=7).
 */
function isoWeekMondayMs(date: Date): number {
  const dayOfWeek = date.getUTCDay() === 0 ? 7 : date.getUTCDay(); // 1=Mon … 7=Sun
  const midnightUtc = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  );
  // Subtract (dayOfWeek - 1) days to land on Monday.
  return midnightUtc - (dayOfWeek - 1) * 86_400_000;
}

// ---------------------------------------------------------------------------
// JSONL reading helpers
// ---------------------------------------------------------------------------

function getUsageLogDir(): string {
  return process.env["USAGE_LOG_DIR"] ?? "var/usage";
}

function monthKey(year: number, month: number): string {
  // month is 0-based (like Date.getUTCMonth())
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/**
 * Reads and parses a single usage JSONL file. Returns an empty array on any
 * error (missing file, permission denied, corrupt JSON lines, etc.) so that
 * budget checks never block a review by throwing.
 */
async function readUsageFile(year: number, month: number): Promise<UsageRecord[]> {
  const dir = getUsageLogDir();
  const path = join(dir, `${monthKey(year, month)}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // File simply does not exist yet — not an error.
    log.debug("budget: usage file not found, treating as empty", { path });
    return [];
  }

  const records: UsageRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (typeof obj === "object" && obj !== null) {
        records.push(obj as UsageRecord);
      }
    } catch {
      // Skip malformed lines — fail-open so one corrupt record never halts reviews.
      log.debug("budget: skipping invalid JSONL line", { path, line: trimmed });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// 60-second in-memory cache per repo
// ---------------------------------------------------------------------------

type CacheEntry = {
  sum: number;
  expiresAt: number; // Date.now() ms
};

const _cache = new Map<string, CacheEntry>();

/** Visible for testing — allows tests to inject a deterministic clock. */
export let _nowMs: () => number = () => Date.now();

/** Replaces the internal clock. Used only in tests. */
export function _setNowMs(fn: () => number): void {
  _nowMs = fn;
}

/** Clears the in-memory cache. Exposed for tests that need a clean slate. */
export function _clearCache(): void {
  _cache.clear();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the total `inputTokens + outputTokens` across all usage records for
 * `repoFull` that fall within the current ISO week (Mon 00:00 UTC → Sun 23:59:59.999 UTC).
 *
 * Results are cached for 60 seconds per repo. The cache means a review that
 * arrives just after the budget is exhausted may still go through during the
 * cache TTL window — this is intentional (fail-open) and disclosed in
 * operator documentation.
 *
 * @param repoFull  Owner/repo string, e.g. "acme/widget".
 * @param now       Reference point for "current week"; defaults to `new Date()`.
 *                  Pass an explicit value in tests for determinism.
 */
export async function getWeeklyTokenSum(
  repoFull: string,
  now: Date = new Date(),
): Promise<number> {
  const repoKey = repoFull.toLowerCase();
  const nowMs = _nowMs();

  // Return cached value if still fresh.
  const cached = _cache.get(repoKey);
  if (cached && nowMs < cached.expiresAt) {
    return cached.sum;
  }

  const weekStartMs = isoWeekMondayMs(now);
  const weekEndMs = weekStartMs + 7 * 86_400_000; // exclusive upper bound (next Mon 00:00 UTC)

  // Determine which calendar months overlap the current ISO week. We always
  // read the current month. If the Monday of this week fell in the *previous*
  // calendar month we also read that file to catch tokens spent before the
  // month boundary.
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth(); // 0-based

  const weekStartDate = new Date(weekStartMs);
  const weekStartYear = weekStartDate.getUTCFullYear();
  const weekStartMonth = weekStartDate.getUTCMonth(); // 0-based

  // Collect month-year pairs to read (deduplicated).
  const monthsToRead: Array<{ year: number; month: number }> = [
    { year: currentYear, month: currentMonth },
  ];
  if (weekStartYear !== currentYear || weekStartMonth !== currentMonth) {
    // Week spans a month boundary — also read the previous month's file.
    monthsToRead.push({ year: weekStartYear, month: weekStartMonth });
  }

  // Read all relevant files in parallel.
  const fileResults = await Promise.all(
    monthsToRead.map(({ year, month }) => readUsageFile(year, month)),
  );
  const allRecords = fileResults.flat();

  let sum = 0;
  for (const record of allRecords) {
    if (record.repo?.toLowerCase() !== repoKey) continue;
    const tsMs = new Date(record.ts).getTime();
    if (isNaN(tsMs)) continue;
    if (tsMs < weekStartMs || tsMs >= weekEndMs) continue;
    sum += (record.inputTokens ?? 0) + (record.outputTokens ?? 0);
  }

  _cache.set(repoKey, { sum, expiresAt: nowMs + 60_000 });
  return sum;
}
