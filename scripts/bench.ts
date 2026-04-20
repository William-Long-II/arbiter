#!/usr/bin/env bun
/**
 * Local benchmark suite for review-me.
 *
 * Run with:  bun run bench
 *
 * Each registered Benchmark runs a warm-up iteration followed by N timed
 * iterations. The suite prints a padded-column results table and exits with
 * code 1 if any benchmark's average exceeds its declared budget. This lets
 * the suite be wired into CI in the future without any further changes.
 */

import { redact } from "../src/util/redact";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Benchmark = {
  /** Human-readable name shown in the results table. */
  name: string;
  /** The work to measure. May be async. */
  fn: () => unknown | Promise<unknown>;
  /** Maximum acceptable average latency in milliseconds. */
  budgetMs: number;
  /** Number of timed iterations (default: 1000). */
  iterations?: number;
  /** Number of warm-up iterations before timing begins (default: 1). */
  warmup?: number;
};

type BenchResult = {
  name: string;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  iterations: number;
  budgetMs: number;
  passed: boolean;
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runBenchmark(b: Benchmark): Promise<BenchResult> {
  const iterations = b.iterations ?? 1000;
  const warmupCount = b.warmup ?? 1;

  // Warm-up: run outside the timed loop so JIT / module caches are hot.
  for (let i = 0; i < warmupCount; i++) {
    await b.fn();
  }

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await b.fn();
    samples.push(performance.now() - t0);
  }

  samples.sort((a, z) => a - z);

  const sum = samples.reduce((acc, v) => acc + v, 0);
  const avgMs = sum / samples.length;
  const p50Ms = samples[Math.floor(samples.length * 0.5)] ?? 0;
  const p95Ms = samples[Math.floor(samples.length * 0.95)] ?? 0;
  const p99Ms = samples[Math.floor(samples.length * 0.99)] ?? 0;

  return {
    name: b.name,
    avgMs,
    p50Ms,
    p95Ms,
    p99Ms,
    iterations,
    budgetMs: b.budgetMs,
    passed: avgMs <= b.budgetMs,
  };
}

// ---------------------------------------------------------------------------
// Table renderer
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  return ms.toFixed(3) + " ms";
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function printTable(results: BenchResult[]): void {
  const cols = {
    name:       "benchmark",
    avg:        "avg",
    p50:        "p50",
    p95:        "p95",
    p99:        "p99",
    iterations: "iters",
    budget:     "budget",
    status:     "status",
  };

  // Column widths derived from data + header.
  const widths = {
    name:       Math.max(cols.name.length, ...results.map((r) => r.name.length)),
    avg:        Math.max(cols.avg.length,  ...results.map((r) => formatMs(r.avgMs).length)),
    p50:        Math.max(cols.p50.length,  ...results.map((r) => formatMs(r.p50Ms).length)),
    p95:        Math.max(cols.p95.length,  ...results.map((r) => formatMs(r.p95Ms).length)),
    p99:        Math.max(cols.p99.length,  ...results.map((r) => formatMs(r.p99Ms).length)),
    iterations: Math.max(cols.iterations.length, ...results.map((r) => String(r.iterations).length)),
    budget:     Math.max(cols.budget.length, ...results.map((r) => formatMs(r.budgetMs).length)),
    status:     Math.max(cols.status.length, 4 /* "PASS" */),
  };

  const row = (
    name: string,
    avg: string,
    p50: string,
    p95: string,
    p99: string,
    iters: string,
    budget: string,
    status: string,
  ): string =>
    [
      pad(name,   widths.name),
      pad(avg,    widths.avg),
      pad(p50,    widths.p50),
      pad(p95,    widths.p95),
      pad(p99,    widths.p99),
      pad(iters,  widths.iterations),
      pad(budget, widths.budget),
      pad(status, widths.status),
    ].join("  ");

  const sep = row(
    "-".repeat(widths.name),
    "-".repeat(widths.avg),
    "-".repeat(widths.p50),
    "-".repeat(widths.p95),
    "-".repeat(widths.p99),
    "-".repeat(widths.iterations),
    "-".repeat(widths.budget),
    "-".repeat(widths.status),
  );

  process.stdout.write("\n");
  process.stdout.write(row(cols.name, cols.avg, cols.p50, cols.p95, cols.p99, cols.iterations, cols.budget, cols.status) + "\n");
  process.stdout.write(sep + "\n");

  for (const r of results) {
    process.stdout.write(
      row(
        r.name,
        formatMs(r.avgMs),
        formatMs(r.p50Ms),
        formatMs(r.p95Ms),
        formatMs(r.p99Ms),
        String(r.iterations),
        formatMs(r.budgetMs),
        r.passed ? "PASS" : "FAIL",
      ) + "\n",
    );
  }

  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// Benchmark registry
// ---------------------------------------------------------------------------

// Helper shared with the payload builder below.
function randomAlpha(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: len }, () =>
    chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}

// Build a ~10 KB plain-object payload with benign field values.
// Mirroring the construction used in the former tests/redact.test.ts perf block
// so the benchmark measures the same workload.
function buildRedactionPayload(): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) {
    payload[`field_${i}`] =
      `Some log message with data ${randomAlpha(60)} and more text here for padding.`;
  }
  return payload;
}

const REDACTION_PAYLOAD = buildRedactionPayload();

const benchmarks: Benchmark[] = [
  {
    name: "redact 10 KB payload",
    fn: () => redact(REDACTION_PAYLOAD),
    budgetMs: 2,
    iterations: 1000,
    warmup: 1,
  },
];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      msg: "bench suite starting",
      count: benchmarks.length,
    }) + "\n",
  );

  const results: BenchResult[] = [];

  for (const b of benchmarks) {
    let result: BenchResult;
    try {
      result = await runBenchmark(b);
    } catch (err: unknown) {
      // A crashing benchmark is a hard failure — report it and exit 1 immediately
      // so the table is not printed with partial/misleading results.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          msg: "benchmark threw an exception",
          benchmark: b.name,
          error: message,
        }) + "\n",
      );
      process.exit(1);
    }
    results.push(result);
  }

  printTable(results);

  const failures = results.filter((r) => !r.passed);

  for (const f of failures) {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "benchmark exceeded budget",
        benchmark: f.name,
        avgMs: Number(f.avgMs.toFixed(3)),
        budgetMs: f.budgetMs,
      }) + "\n",
    );
  }

  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      msg: failures.length === 0 ? "bench suite PASSED" : "bench suite FAILED",
      passed: results.length - failures.length,
      failed: failures.length,
      total: results.length,
    }) + "\n",
  );

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "bench suite crashed",
      error: message,
    }) + "\n",
  );
  process.exit(1);
});
