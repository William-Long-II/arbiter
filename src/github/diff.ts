import type { Octokit } from "./client";

export type PullRequestFile = {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
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
      files.push({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch,
        previous_filename: f.previous_filename,
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
