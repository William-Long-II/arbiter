import type { PullRequestFile } from "../github";

/** Normalized per-file diff data used throughout the chunked review pipeline. */
export type FileDiff = {
  path: string;
  status: PullRequestFile["status"];
  patch: string;
  additions: number;
  deletions: number;
  previous_path?: string;
};

/** Result of planning how to review a set of files in batches. */
export type ReviewPlan = {
  batches: FileDiff[][];
};

export const DEFAULT_BATCH_BUDGET_CHARS = 50_000;

/**
 * Converts a `PullRequestFile` array into the `FileDiff` shape used by the
 * chunked pipeline. Files without a patch are assigned an empty string so
 * downstream code never has to guard against `undefined`.
 */
export function toFileDiffs(files: PullRequestFile[]): FileDiff[] {
  return files.map((f) => ({
    path: f.filename,
    status: f.status,
    patch: f.patch ?? "",
    additions: f.additions,
    deletions: f.deletions,
    previous_path: f.previous_filename,
  }));
}

/**
 * Greedy bin-pack `files` into batches where each batch's total patch length
 * does not exceed `budgetChars`.
 *
 * Rules:
 * - A file whose patch alone exceeds `budgetChars` is placed in its own batch
 *   (oversize batches are never dropped or truncated).
 * - Files are processed in input order so the result is deterministic.
 * - Empty input produces an empty batches array.
 */
export function planReview(
  files: FileDiff[],
  budgetChars: number = DEFAULT_BATCH_BUDGET_CHARS,
): ReviewPlan {
  if (files.length === 0) return { batches: [] };

  const batches: FileDiff[][] = [];
  let currentBatch: FileDiff[] = [];
  let currentSize = 0;

  for (const file of files) {
    const fileSize = file.patch.length;

    if (currentBatch.length === 0) {
      // Always start a new batch with the file, even if it exceeds the budget.
      currentBatch.push(file);
      currentSize = fileSize;
    } else if (currentSize + fileSize <= budgetChars) {
      // File fits within the current batch.
      currentBatch.push(file);
      currentSize += fileSize;
    } else {
      // File would overflow — flush and start a new batch.
      batches.push(currentBatch);
      currentBatch = [file];
      currentSize = fileSize;
    }
  }

  // Flush the last batch.
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return { batches };
}
