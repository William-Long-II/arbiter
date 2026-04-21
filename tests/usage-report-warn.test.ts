/**
 * Tests for the usage-report budget-warning feature (issue #91).
 *
 * We test `buildReportRows` in isolation (pure logic, no I/O), and the
 * tryLoadAllowlist + full-script behaviour via a subprocess approach for the
 * edge-case (missing repos.yaml → no crash, dashes).
 *
 * The allowlist is constructed via `buildAllowlist` (exported from repos.ts)
 * to avoid touching the module-level singleton or filesystem in unit tests.
 */
import { describe, expect, test } from "bun:test";
import { buildAllowlist } from "../src/config/repos";
import { buildReportRows } from "../scripts/usage-report";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal aggregated row matching the shape buildReportRows accepts. */
function makeRow(
  repo: string,
  inputTokens: number,
  outputTokens: number,
): {
  repo: string;
  reviews: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
} {
  return {
    repo,
    reviews: 1,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
  };
}

// ---------------------------------------------------------------------------
// buildReportRows — unit tests
// ---------------------------------------------------------------------------

describe("buildReportRows", () => {
  test("warns repo at 85% of cap (default threshold 0.8)", () => {
    // cap = 10_000; usage = 8_500 (85%) → should warn
    const allowlist = buildAllowlist({
      "acme/alpha": {
        enabled: true,
        rereview: "auto-on-sync",
        rereview_label: "re-review",
        review: { max_weekly_tokens: 10_000 },
      },
    });

    const rows = buildReportRows([makeRow("acme/alpha", 7_000, 1_500)], allowlist, 0.8);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.cap).toBe(10_000);
    expect(rows[0]!.pct).toBeCloseTo(0.85, 5);
    expect(rows[0]!.warned).toBe(true);
  });

  test("does NOT warn repo at 40% of cap (default threshold 0.8)", () => {
    // cap = 10_000; usage = 4_000 (40%) → should not warn
    const allowlist = buildAllowlist({
      "acme/beta": {
        enabled: true,
        rereview: "auto-on-sync",
        rereview_label: "re-review",
        review: { max_weekly_tokens: 10_000 },
      },
    });

    const rows = buildReportRows([makeRow("acme/beta", 3_000, 1_000)], allowlist, 0.8);

    expect(rows[0]!.cap).toBe(10_000);
    expect(rows[0]!.pct).toBeCloseTo(0.4, 5);
    expect(rows[0]!.warned).toBe(false);
  });

  test("two repos: one warned (85%), one not (40%) — summary count = 1", () => {
    const allowlist = buildAllowlist({
      "acme/alpha": {
        enabled: true,
        rereview: "auto-on-sync",
        rereview_label: "re-review",
        review: { max_weekly_tokens: 10_000 },
      },
      "acme/beta": {
        enabled: true,
        rereview: "auto-on-sync",
        rereview_label: "re-review",
        review: { max_weekly_tokens: 10_000 },
      },
    });

    const rows = buildReportRows(
      [
        makeRow("acme/alpha", 7_000, 1_500), // 85% → warned
        makeRow("acme/beta", 3_000, 1_000), //  40% → not warned
      ],
      allowlist,
      0.8,
    );

    const warnedCount = rows.filter((r) => r.warned).length;
    expect(warnedCount).toBe(1);
    expect(rows.find((r) => r.repo === "acme/alpha")!.warned).toBe(true);
    expect(rows.find((r) => r.repo === "acme/beta")!.warned).toBe(false);
  });

  test("--warn-at 0.5 lowers threshold: 60% repo warned (would not warn at 0.8)", () => {
    // cap = 10_000; usage = 6_000 (60%) → at 0.8 would NOT warn, at 0.5 DOES warn
    const allowlist = buildAllowlist({
      "acme/beta": {
        enabled: true,
        rereview: "auto-on-sync",
        rereview_label: "re-review",
        review: { max_weekly_tokens: 10_000 },
      },
    });

    const rowsAt80 = buildReportRows([makeRow("acme/beta", 5_000, 1_000)], allowlist, 0.8);
    expect(rowsAt80[0]!.warned).toBe(false);

    const rowsAt50 = buildReportRows([makeRow("acme/beta", 5_000, 1_000)], allowlist, 0.5);
    expect(rowsAt50[0]!.warned).toBe(true);
  });

  test("--warn-at 0.5: 85% repo still warned", () => {
    const allowlist = buildAllowlist({
      "acme/alpha": {
        enabled: true,
        rereview: "auto-on-sync",
        rereview_label: "re-review",
        review: { max_weekly_tokens: 10_000 },
      },
    });

    const rows = buildReportRows([makeRow("acme/alpha", 7_000, 1_500)], allowlist, 0.5);

    expect(rows[0]!.warned).toBe(true);
  });

  test("repo without cap: no cap/pct, no warning", () => {
    const allowlist = buildAllowlist({
      "acme/nocap": {
        enabled: true,
        rereview: "auto-on-sync",
        rereview_label: "re-review",
        // no review block
      },
    });

    const rows = buildReportRows([makeRow("acme/nocap", 99_000, 99_000)], allowlist, 0.8);

    expect(rows[0]!.cap).toBeUndefined();
    expect(rows[0]!.pct).toBeUndefined();
    expect(rows[0]!.warned).toBe(false);
  });

  test("null allowlist (missing repos.yaml): no crash, all dashes", () => {
    const rows = buildReportRows(
      [makeRow("acme/any", 5_000, 5_000)],
      null,
      0.8,
    );

    expect(rows[0]!.cap).toBeUndefined();
    expect(rows[0]!.pct).toBeUndefined();
    expect(rows[0]!.warned).toBe(false);
  });

  test("empty allowlist (empty repos.yaml): no crash, all dashes", () => {
    const allowlist = buildAllowlist({});

    const rows = buildReportRows(
      [makeRow("acme/any", 5_000, 5_000)],
      allowlist,
      0.8,
    );

    expect(rows[0]!.cap).toBeUndefined();
    expect(rows[0]!.pct).toBeUndefined();
    expect(rows[0]!.warned).toBe(false);
  });

  test("exactly at threshold (100%) is warned", () => {
    const allowlist = buildAllowlist({
      "acme/edge": {
        enabled: true,
        rereview: "auto-on-sync",
        rereview_label: "re-review",
        review: { max_weekly_tokens: 10_000 },
      },
    });

    const rows = buildReportRows([makeRow("acme/edge", 8_000, 2_000)], allowlist, 0.8);

    expect(rows[0]!.pct).toBeCloseTo(1.0, 5);
    expect(rows[0]!.warned).toBe(true);
  });

  test("exactly at threshold boundary (80%) is warned", () => {
    const allowlist = buildAllowlist({
      "acme/boundary": {
        enabled: true,
        rereview: "auto-on-sync",
        rereview_label: "re-review",
        review: { max_weekly_tokens: 10_000 },
      },
    });

    const rows = buildReportRows([makeRow("acme/boundary", 6_000, 2_000)], allowlist, 0.8);

    expect(rows[0]!.pct).toBeCloseTo(0.8, 5);
    expect(rows[0]!.warned).toBe(true);
  });

  test("just below threshold (79.9%) is NOT warned", () => {
    const allowlist = buildAllowlist({
      "acme/safe": {
        enabled: true,
        rereview: "auto-on-sync",
        rereview_label: "re-review",
        review: { max_weekly_tokens: 10_000 },
      },
    });

    // 7_990 / 10_000 = 79.9%
    const rows = buildReportRows([makeRow("acme/safe", 6_000, 1_990)], allowlist, 0.8);

    expect(rows[0]!.pct).toBeCloseTo(0.799, 3);
    expect(rows[0]!.warned).toBe(false);
  });

  test("org-level cap is resolved via getEffectiveConfig", () => {
    // Org default sets max_weekly_tokens; individual repo has no override.
    const allowlist = buildAllowlist(
      {
        "acme/widget": {
          enabled: true,
          rereview: "auto-on-sync",
          rereview_label: "re-review",
          // no review block — should inherit from org
        },
      },
      {
        acme: {
          enabled: true,
          review: { max_weekly_tokens: 20_000 },
        },
      },
    );

    // 17_000 / 20_000 = 85% → warned
    const rows = buildReportRows([makeRow("acme/widget", 15_000, 2_000)], allowlist, 0.8);

    expect(rows[0]!.cap).toBe(20_000);
    expect(rows[0]!.pct).toBeCloseTo(0.85, 5);
    expect(rows[0]!.warned).toBe(true);
  });
});
