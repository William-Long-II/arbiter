import { octokitFor } from './api.ts';

export type PRDetails = {
  repoFull: string;
  number: number;
  title: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  draft: boolean;
};

/**
 * Fetch a PR's metadata and unified diff. The diff is requested via GitHub's
 * `application/vnd.github.diff` media type — Octokit returns it as a raw
 * string in `.data`, not the JSON shape its types suggest.
 */
export async function fetchPullRequest(
  token: string,
  repoFull: string,
  pullNumber: number,
): Promise<{ pr: PRDetails; diff: string }> {
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFull: ${repoFull}`);

  const octokit = octokitFor(token);

  const [meta, diffResp] = await Promise.all([
    octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber }),
    octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: { format: 'diff' },
    }),
  ]);

  const m = meta.data;
  return {
    pr: {
      repoFull,
      number: pullNumber,
      title: m.title,
      author: m.user?.login ?? 'unknown',
      baseBranch: m.base.ref,
      headBranch: m.head.ref,
      headSha: m.head.sha,
      draft: m.draft ?? false,
    },
    diff: diffResp.data as unknown as string,
  };
}
