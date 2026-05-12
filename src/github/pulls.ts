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

const LIST_PAGE_SIZE = 100;

/**
 * List open PRs in a single repo. Used by the poller for repo-scoped rules.
 * Returns every page concatenated, capped at a few thousand to avoid runaway.
 */
export async function listOpenPullsForRepo(
  token: string,
  repoFull: string,
): Promise<PRDetails[]> {
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFull: ${repoFull}`);
  const octokit = octokitFor(token);
  const out: PRDetails[] = [];
  for (let page = 1; page <= 30; page++) {
    const res = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      per_page: LIST_PAGE_SIZE,
      page,
    });
    if (res.data.length === 0) break;
    for (const p of res.data) {
      if (p.draft) continue;
      out.push({
        repoFull,
        number: p.number,
        title: p.title,
        author: p.user?.login ?? 'unknown',
        baseBranch: p.base.ref,
        headBranch: p.head.ref,
        headSha: p.head.sha,
        draft: p.draft ?? false,
      });
    }
    if (res.data.length < LIST_PAGE_SIZE) break;
  }
  return out;
}

/**
 * List open PRs across an entire org. Uses the search API (`is:pr is:open
 * org:foo`) rather than walking every repo — a 334-repo org would burn the
 * full hourly quota every poll if we listed pulls per repo.
 *
 * Search results don't include head/base SHAs, so each match is fetched
 * individually via pulls.get. Capped at 200 open PRs per poll (search
 * returns 100 per page; we walk at most two pages). Larger orgs may
 * temporarily miss PRs beyond that — fine for MVP; revisit if it becomes
 * a real constraint.
 */
export async function listOpenPullsForOrg(
  token: string,
  org: string,
): Promise<PRDetails[]> {
  const octokit = octokitFor(token);
  const items: Array<{ repoFull: string; number: number }> = [];
  for (let page = 1; page <= 2; page++) {
    const res = await octokit.rest.search.issuesAndPullRequests({
      q: `is:pr is:open org:${org}`,
      per_page: LIST_PAGE_SIZE,
      page,
    });
    for (const item of res.data.items) {
      // repository_url looks like https://api.github.com/repos/owner/name
      const m = /\/repos\/([^/]+\/[^/]+)$/.exec(item.repository_url);
      if (!m) continue;
      items.push({ repoFull: m[1]!, number: item.number });
    }
    if (res.data.items.length < LIST_PAGE_SIZE) break;
  }

  // Parallel fetch each PR for the fields search doesn't return.
  const results = await Promise.all(
    items.map(async ({ repoFull, number }): Promise<PRDetails | null> => {
      try {
        const [owner, repo] = repoFull.split('/');
        if (!owner || !repo) return null;
        const res = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: number,
        });
        const p = res.data;
        if (p.draft) return null;
        return {
          repoFull,
          number: p.number,
          title: p.title,
          author: p.user?.login ?? 'unknown',
          baseBranch: p.base.ref,
          headBranch: p.head.ref,
          headSha: p.head.sha,
          draft: p.draft ?? false,
        };
      } catch {
        return null; // Skip individual fetch failures (deleted, perms changed, etc.)
      }
    }),
  );
  return results.filter((r): r is PRDetails => r !== null);
}
