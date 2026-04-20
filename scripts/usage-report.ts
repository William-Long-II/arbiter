import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { aggregateRecords, type UsageRecord } from "../src/review/usage";

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

function parseArgs(): { since?: Date; logDir: string } {
  const args = process.argv.slice(2);
  let since: Date | undefined;
  const logDir = process.env["USAGE_LOG_DIR"] ?? "var/usage";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--since" && args[i + 1]) {
      since = parseSinceDuration(args[i + 1]!);
      i++;
    } else if (args[i]?.startsWith("--since=")) {
      since = parseSinceDuration(args[i]!.slice("--since=".length));
    }
  }

  return { since, logDir };
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

function fmtNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function printTable(
  rows: Array<{
    repo: string;
    reviews: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    estimatedCostUsd: number;
  }>,
): void {
  const COL_WIDTHS = {
    repo: Math.max(4, ...rows.map((r) => r.repo.length)),
    reviews: 7,
    input: 10,
    output: 10,
    cacheR: 10,
    cacheC: 12,
    cost: 12,
  };

  const pad = (s: string, w: number) => s.padEnd(w);
  const rpad = (s: string, w: number) => s.padStart(w);

  const header = [
    pad("repo", COL_WIDTHS.repo),
    rpad("reviews", COL_WIDTHS.reviews),
    rpad("input tok", COL_WIDTHS.input),
    rpad("output tok", COL_WIDTHS.output),
    rpad("cache read", COL_WIDTHS.cacheR),
    rpad("cache create", COL_WIDTHS.cacheC),
    rpad("est. cost", COL_WIDTHS.cost),
  ].join("  ");

  const sep = "-".repeat(header.length);

  console.log(header);
  console.log(sep);

  for (const r of rows) {
    const line = [
      pad(r.repo, COL_WIDTHS.repo),
      rpad(String(r.reviews), COL_WIDTHS.reviews),
      rpad(fmtNumber(r.inputTokens), COL_WIDTHS.input),
      rpad(fmtNumber(r.outputTokens), COL_WIDTHS.output),
      rpad(fmtNumber(r.cacheReadTokens), COL_WIDTHS.cacheR),
      rpad(fmtNumber(r.cacheCreationTokens), COL_WIDTHS.cacheC),
      rpad(fmtCost(r.estimatedCostUsd), COL_WIDTHS.cost),
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

  const footer = [
    pad("TOTAL", COL_WIDTHS.repo),
    rpad(String(totals.reviews), COL_WIDTHS.reviews),
    rpad(fmtNumber(totals.inputTokens), COL_WIDTHS.input),
    rpad(fmtNumber(totals.outputTokens), COL_WIDTHS.output),
    rpad(fmtNumber(totals.cacheReadTokens), COL_WIDTHS.cacheR),
    rpad(fmtNumber(totals.cacheCreationTokens), COL_WIDTHS.cacheC),
    rpad(fmtCost(totals.estimatedCostUsd), COL_WIDTHS.cost),
  ].join("  ");

  console.log(footer);
}

async function main(): Promise<void> {
  const { since, logDir } = parseArgs();

  const records = await loadRecords(logDir);
  const rows = aggregateRecords(records, since);

  const label = since
    ? `since ${since.toISOString().slice(0, 10)}`
    : "all time";
  console.log(`\nToken usage report — ${label}\n`);

  if (rows.length === 0) {
    console.log("No usage records found.");
    return;
  }

  printTable(rows);
  console.log();
}

await main();
