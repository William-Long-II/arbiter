import type { Octokit } from "./client";

export type PullRequestFile = {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
  /** Estimated similarity percentage (0–100) for renamed files; absent for other statuses. */
  similarity?: number;
};

export type PullRequestDiff = {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
  files: PullRequestFile[];
  totals: { additions: number; deletions: number; changedFiles: number };
};

/**
 * Estimate rename similarity from a unified diff patch.
 *
 * Counts lines that begin with ' ' (context/unchanged), '+', or '-'.
 * Similarity = unchanged / (unchanged + changed).
 * Returns undefined when the patch is absent or has no measurable lines
 * (e.g. pure rename with no diff body beyond the hunk header).
 */
function estimateSimilarity(patch: string | undefined, additions: number, deletions: number): number | undefined {
  // Pure rename — no content change at all.
  if (additions === 0 && deletions === 0) return 100;

  if (!patch) return undefined;

  let unchanged = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith(" ")) unchanged++;
  }

  const changed = additions + deletions;
  const total = unchanged + changed;
  // Guard against degenerate patches with no measurable lines.
  if (total === 0) return undefined;

  return Math.round((unchanged / total) * 100);
}

/**
 * Build the `RENAMED:` header line that is prepended to the patch for renamed
 * files so downstream consumers (prompt builder) carry rename context without
 * requiring changes to src/review/prompt.ts.
 */
function buildRenameHeader(previousPath: string, newPath: string, similarity: number | undefined): string {
  const simPart = similarity !== undefined ? `${similarity}%` : "unknown";
  return `RENAMED: ${previousPath} -> ${newPath} (similarity ${simPart})`;
}

export async function fetchPullRequestDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequestDiff> {
  const pr = await octokit.pulls.get({ owner, repo, pull_number: number });

  const files: PullRequestFile[] = [];
  for await (const page of octokit.paginate.iterator(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  })) {
    for (const f of page.data) {
      let patch = f.patch;
      let similarity: number | undefined;

      if (f.status === "renamed") {
        // previous_filename is guaranteed by the GitHub API for renamed files;
        // fall back to treating the file as modified if it is somehow absent.
        const previousPath = f.previous_filename ?? f.filename;
        similarity = estimateSimilarity(patch, f.additions, f.deletions);
        const header = buildRenameHeader(previousPath, f.filename, similarity);
        // For pure renames the patch is undefined; the header becomes the full patch.
        patch = patch ? `${header}\n\n${patch}` : header;
      }

      files.push({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch,
        previous_filename: f.previous_filename,
        ...(similarity !== undefined ? { similarity } : {}),
      });
    }
  }

  return {
    owner,
    repo,
    number,
    headSha: pr.data.head.sha,
    baseSha: pr.data.base.sha,
    title: pr.data.title,
    body: pr.data.body ?? "",
    files,
    totals: {
      additions: pr.data.additions,
      deletions: pr.data.deletions,
      changedFiles: pr.data.changed_files,
    },
  };
}
