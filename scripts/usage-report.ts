import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { aggregateRecords, type UsageRecord } from "../src/review/usage";
import type { RepoAllowlist } from "../src/config/repos";

function parseSinceDuration(raw: string): Date {
  const m = /^(\d+)d$/.exec(raw);
  if (!m || !m[1]) {
    throw new Error(`Unrecognised --since format "${raw}". Expected e.g. "7d".`);
  }
  const days = parseInt(m[1], 10);
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  since.setUTCHours(0, 0, 0, 0);
  return since;
}

function parseArgs(): { since?: Date; logDir: string; warnAt: number; reposPath: string } {
  const args = process.argv.slice(2);
  let since: Date | undefined;
  const logDir = process.env["USAGE_LOG_DIR"] ?? "var/usage";
  const reposPath = process.env["REPOS_PATH"] ?? "./repos.yaml";
  let warnAt = 0.8;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since" && args[i + 1]) {
      since = parseSinceDuration(args[i + 1]!);
      i++;
    } else if (args[i]?.startsWith("--since=")) {
      since = parseSinceDuration(args[i]!.slice("--since=".length));
    } else if (args[i] === "--warn-at" && args[i + 1]) {
      const v = parseFloat(args[i + 1]!);
      if (!isNaN(v) && v >= 0 && v <= 1) warnAt = v;
      i++;
    } else if (args[i]?.startsWith("--warn-at=")) {
      const v = parseFloat(args[i]!.slice("--warn-at=".length));
      if (!isNaN(v) && v >= 0 && v <= 1) warnAt = v;
    }
  }

  return { since, logDir, warnAt, reposPath };
}

async function loadRecords(logDir: string): Promise<UsageRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch {
    return [];
  }

  const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl")).sort();
  const records: UsageRecord[] = [];

  for (const file of jsonlFiles) {
    const text = await readFile(join(logDir, file), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as UsageRecord);
      } catch {
        // skip malformed lines
      }
    }
  }

  return records;
}

/**
 * Try to load repos.yaml and return an allowlist. Returns null when the file
 * is absent, empty, or unparseable — callers treat null as "no caps known".
 *
 * We call `loadReposFile` which seeds the module-level singleton; that's
 * acceptable here since the report script runs once and exits. The singleton
 * is isolated to this process.
 */
async function tryLoadAllowlist(reposPath: string): Promise<RepoAllowlist | null> {
  let raw: string;
  try {
    raw = await readFile(reposPath, "utf8");
  } catch {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Dynamic import to avoid executing module side-effects when not needed and
  // to isolate parse failures from the main execution path.
  try {
    const { loadReposFile } = await import("../src/config/repos");
    return loadReposFile(reposPath);
  } catch {
    return null;
  }
}

function fmtNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function fmtPct(pct: number): string {
  return `${Math.round(pct * 100)}%`;
}

function fmtCap(cap: number | undefined): string {
  return cap !== undefined ? fmtNumber(cap) : "—";
}

type ReportRow = {
  repo: string;
  reviews: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
  cap?: number;
  pct?: number;
  warned: boolean;
};

export function buildReportRows(
  rows: Array<{
    repo: string;
    reviews: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estimatedCostUsd: number;
  }>,
  allowlist: RepoAllowlist | null,
  warnAt: number,
): ReportRow[] {
  return rows.map((r) => {
    const cfg = allowlist?.getEffectiveConfig(r.repo);
    const cap = cfg?.review?.max_weekly_tokens;
    const totalTokens = r.inputTokens + r.outputTokens;

    if (cap === undefined) {
      return { ...r, warned: false };
    }

    const pct = cap > 0 ? totalTokens / cap : 0;
    const warned = pct >= warnAt;
    return { ...r, cap, pct, warned };
  });
}

function printTable(rows: ReportRow[], showBudgetCols: boolean): void {
  const WARN_GLYPH = "⚠";

  // Repo column width must account for possible glyph suffix (⚠ is 1 char visually
  // but may be 3 bytes — we measure display width by string .length).
  const repoDisplayLen = (r: ReportRow) =>
    r.repo.length + (r.warned ? ` ${WARN_GLYPH}`.length : 0);

  const COL_WIDTHS = {
    repo: Math.max(4, ...rows.map(repoDisplayLen)),
    reviews: 7,
    input: 10,
    output: 10,
    cacheR: 10,
    cacheC: 12,
    cost: 12,
    cap: 10,
    pct: 6,
  };

  const pad = (s: string, w: number) => s.padEnd(w);
  const rpad = (s: string, w: number) => s.padStart(w);

  const budgetHeaders = showBudgetCols
    ? [rpad("cap (tok)", COL_WIDTHS.cap), rpad("% cap", COL_WIDTHS.pct)]
    : [];

  const header = [
    pad("repo", COL_WIDTHS.repo),
    rpad("reviews", COL_WIDTHS.reviews),
    rpad("input tok", COL_WIDTHS.input),
    rpad("output tok", COL_WIDTHS.output),
    rpad("cache read", COL_WIDTHS.cacheR),
    rpad("cache create", COL_WIDTHS.cacheC),
    rpad("est. cost", COL_WIDTHS.cost),
    ...budgetHeaders,
  ].join("  ");

  const sep = "-".repeat(header.length);

  console.log(header);
  console.log(sep);

  for (const r of rows) {
    const repoLabel = r.warned ? `${r.repo} ${WARN_GLYPH}` : r.repo;
    const budgetCols = showBudgetCols
      ? [
          rpad(fmtCap(r.cap), COL_WIDTHS.cap),
          rpad(r.pct !== undefined ? fmtPct(r.pct) : "—", COL_WIDTHS.pct),
        ]
      : [];

    const line = [
      pad(repoLabel, COL_WIDTHS.repo),
      rpad(String(r.reviews), COL_WIDTHS.reviews),
      rpad(fmtNumber(r.inputTokens), COL_WIDTHS.input),
      rpad(fmtNumber(r.outputTokens), COL_WIDTHS.output),
      rpad(fmtNumber(r.cacheReadTokens), COL_WIDTHS.cacheR),
      rpad(fmtNumber(r.cacheCreationTokens), COL_WIDTHS.cacheC),
      rpad(fmtCost(r.estimatedCostUsd), COL_WIDTHS.cost),
      ...budgetCols,
    ].join("  ");
    console.log(line);
  }

  console.log(sep);

  const totals = rows.reduce(
    (acc, r) => ({
      reviews: acc.reviews + r.reviews,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
      estimatedCostUsd: acc.estimatedCostUsd + r.estimatedCostUsd,
    }),
    {
      reviews: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
    },
  );

  const budgetTotalCols = showBudgetCols ? [rpad("—", COL_WIDTHS.cap), rpad("—", COL_WIDTHS.pct)] : [];

  const footer = [
    pad("TOTAL", COL_WIDTHS.repo),
    rpad(String(totals.reviews), COL_WIDTHS.reviews),
    rpad(fmtNumber(totals.inputTokens), COL_WIDTHS.input),
    rpad(fmtNumber(totals.outputTokens), COL_WIDTHS.output),
    rpad(fmtNumber(totals.cacheReadTokens), COL_WIDTHS.cacheR),
    rpad(fmtNumber(totals.cacheCreationTokens), COL_WIDTHS.cacheC),
    rpad(fmtCost(totals.estimatedCostUsd), COL_WIDTHS.cost),
    ...budgetTotalCols,
  ].join("  ");

  console.log(footer);
}

async function main(): Promise<void> {
  const { since, logDir, warnAt, reposPath } = parseArgs();

  const records = await loadRecords(logDir);
  const aggregated = aggregateRecords(records, since);

  const label = since
    ? `since ${since.toISOString().slice(0, 10)}`
    : "all time";
  console.log(`\nToken usage report — ${label}\n`);

  if (aggregated.length === 0) {
    console.log("No usage records found.");
    return;
  }

  const allowlist = await tryLoadAllowlist(reposPath);
  const rows = buildReportRows(aggregated, allowlist, warnAt);

  // Show budget columns only when at least one repo has a cap configured.
  const showBudgetCols = rows.some((r) => r.cap !== undefined);

  printTable(rows, showBudgetCols);

  const warnedCount = rows.filter((r) => r.warned).length;
  const thresholdPct = Math.round(warnAt * 100);
  console.log(`\n${warnedCount} repo${warnedCount !== 1 ? "s" : ""} at ≥${thresholdPct}% of cap this week.`);
  console.log();
}

// Only execute when run directly (not when imported by tests).
if (import.meta.main) {
  await main();
}
