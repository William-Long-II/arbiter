/**
 * Configurable thresholds for the large-PR warning signal.
 *
 * Both values are read once at module-load time from environment variables so
 * that the server picks them up on start and tests can override them by
 * mutating the exported object before importing `src/review/index.ts`.
 *
 * Env vars:
 *   LARGE_PR_FILES_THRESHOLD  — kept-file count that triggers the warning (default 50)
 *   LARGE_PR_LOC_THRESHOLD    — sum of additions+deletions over kept files (default 3000)
 *
 * Design note: thresholds are process-global. A future per-org/per-repo
 * override would require plumbing RepoReviewConfig, which is out of scope for
 * this issue (#81).
 */

function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export const largePrThresholds = {
  files: parseIntEnv("LARGE_PR_FILES_THRESHOLD", 50),
  loc: parseIntEnv("LARGE_PR_LOC_THRESHOLD", 3000),
};
