import { octokitFor } from './api.ts';

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

/**
 * Post a PR review with a body. Defaults to COMMENT — neither approving
 * nor requesting changes. Posting as the OAuth'd user (their token), so
 * the review will be authored by them on the PR thread.
 */
export async function postPullRequestReview(
  token: string,
  repoFull: string,
  pullNumber: number,
  body: string,
  event: ReviewEvent = 'COMMENT',
): Promise<{ id: number; htmlUrl: string }> {
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFull: ${repoFull}`);
  const octokit = octokitFor(token);
  const res = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    body,
    event,
  });
  return { id: res.data.id, htmlUrl: res.data.html_url };
}

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
