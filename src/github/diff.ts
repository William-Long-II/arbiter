import type { GH } from "./client.ts";
import type { RepoRef } from "./discover.ts";

export type FileDiff = {
  path: string;
  /** Set of line numbers (on the RIGHT/new file) that appear as added or context in some hunk. */
  rightLines: Set<number>;
  /** Set of line numbers (on the LEFT/old file) that appear as deleted or context in some hunk. */
  leftLines: Set<number>;
  /** Raw unified-diff patch (for feeding to Claude). */
  patch: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
};

export type PrContext = {
  title: string;
  body: string;
  base_ref: string;
  head_ref: string;
  head_sha: string;
  files: FileDiff[];
};

export async function fetchPrContext(
  gh: GH,
  repo: RepoRef,
  pull_number: number,
): Promise<PrContext> {
  const pr = await gh.pulls.get({ owner: repo.owner, repo: repo.name, pull_number });
  const files = await paginate(gh, repo, pull_number);

  return {
    title: pr.data.title,
    body: pr.data.body ?? "",
    base_ref: pr.data.base.ref,
    head_ref: pr.data.head.ref,
    head_sha: pr.data.head.sha,
    files: files.map((f) => {
      const patch = f.patch ?? "";
      const { rightLines, leftLines } = parseHunks(patch);
      return {
        path: f.filename,
        patch,
        rightLines,
        leftLines,
        status: f.status as FileDiff["status"],
      };
    }),
  };
}

async function paginate(gh: GH, repo: RepoRef, pull_number: number) {
  const all: Awaited<ReturnType<GH["pulls"]["listFiles"]>>["data"] = [];
  let page = 1;
  while (true) {
    const res = await gh.pulls.listFiles({
      owner: repo.owner,
      repo: repo.name,
      pull_number,
      per_page: 100,
      page,
    });
    all.push(...res.data);
    if (res.data.length < 100) break;
    page += 1;
  }
  return all;
}

/**
 * Parse a unified-diff patch (as returned by GitHub) into the sets of line
 * numbers GitHub will accept for review comments.
 *
 * Hunk header format:  @@ -<oldStart>,<oldCount> +<newStart>,<newCount> @@ ...
 * Counts are optional (default 1). Within a hunk:
 *   ' '  = context  (advances both sides)
 *   '+'  = addition (advances RIGHT only)
 *   '-'  = deletion (advances LEFT only)
 *   '\'  = "No newline at end of file" marker — ignore
 */
export function parseHunks(patch: string): { rightLines: Set<number>; leftLines: Set<number> } {
  const rightLines = new Set<number>();
  const leftLines = new Set<number>();
  if (!patch) return { rightLines, leftLines };

  const lines = patch.split("\n");
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of lines) {
    const header = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("\\")) continue;

    const marker = raw[0];
    if (marker === "+") {
      rightLines.add(newLine);
      newLine += 1;
    } else if (marker === "-") {
      leftLines.add(oldLine);
      oldLine += 1;
    } else if (marker === " " || marker === undefined) {
      // context line (or a completely blank line, which is still context)
      rightLines.add(newLine);
      leftLines.add(oldLine);
      newLine += 1;
      oldLine += 1;
    } else {
      // Unexpected marker — bail out of the hunk to be safe.
      inHunk = false;
    }
  }

  return { rightLines, leftLines };
}
