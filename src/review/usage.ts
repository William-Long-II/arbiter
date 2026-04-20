import { mkdir, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";

/**
 * Known verdict values stored in usage records.
 * Using a union here gives call-sites and tests a single authoritative list.
 * The `verdict` field on UsageRecord is kept as `string` so that unexpected
 * values from old files do not fail at parse time.
 */
export type UsageVerdict =
  | "approve"
  | "comment"
  | "too_large"
  | "budget_exhausted";

export type UsageRecord = {
  ts: string;
  repo: string;
  pr: number;
  headSha: string;
  model: string;
  /** See UsageVerdict for known values. */
  verdict: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Which pass in a chunked review this record belongs to; null for single-pass reviews. */
  pass?: 1 | 2 | null;
};

export type RecordUsageInput = {
  repo: string;
  pr: number;
  headSha: string;
  model: string;
  verdict: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Which pass in a chunked review this record belongs to; null for single-pass reviews. */
  pass?: 1 | 2 | null;
};

// Pricing per million tokens (as of model release; update when Anthropic publishes new rates)
const COST_PER_M: Record<string, { input: number; output: number; cacheRead: number; cacheCreation: number }> = {
  "claude-opus-4-7": { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  "claude-haiku-3-5": { input: 0.8, output: 4, cacheRead: 0.08, cacheCreation: 1 },
};

function getUsageLogDir(): string {
  return process.env["USAGE_LOG_DIR"] ?? "var/usage";
}

function monthKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export async function recordUsage(input: RecordUsageInput): Promise<void> {
  const now = new Date();
  const record: UsageRecord = {
    ts: now.toISOString(),
    repo: input.repo,
    pr: input.pr,
    headSha: input.headSha,
    model: input.model,
    verdict: input.verdict,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    cacheCreationTokens: input.cacheCreationTokens ?? 0,
    ...(input.pass !== undefined ? { pass: input.pass } : {}),
  };

  const logDir = getUsageLogDir();
  const filePath = join(logDir, `${monthKey(now)}.jsonl`);

  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
}

export type RepoAggregate = {
  repo: string;
  reviews: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
};

export function estimateCost(record: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}): number {
  const rates = COST_PER_M[record.model];
  if (!rates) return 0;
  return (
    (record.inputTokens * rates.input +
      record.outputTokens * rates.output +
      record.cacheReadTokens * rates.cacheRead +
      record.cacheCreationTokens * rates.cacheCreation) /
    1_000_000
  );
}

export function aggregateRecords(
  records: UsageRecord[],
  since?: Date,
): RepoAggregate[] {
  const filtered = since
    ? records.filter((r) => new Date(r.ts) >= since)
    : records;

  const byRepo = new Map<string, RepoAggregate>();

  for (const r of filtered) {
    let agg = byRepo.get(r.repo);
    if (!agg) {
      agg = {
        repo: r.repo,
        reviews: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
      };
      byRepo.set(r.repo, agg);
    }
    agg.reviews += 1;
    agg.inputTokens += r.inputTokens;
    agg.outputTokens += r.outputTokens;
    agg.cacheReadTokens += r.cacheReadTokens;
    agg.cacheCreationTokens += r.cacheCreationTokens;
    agg.estimatedCostUsd += estimateCost(r);
  }

  return Array.from(byRepo.values()).sort((a, b) =>
    a.repo.localeCompare(b.repo),
  );
}
