import { octokitFor } from './api.ts';

/**
 * Set a commit status on `sha`. Used for the opt-in blocking gate: a
 * `failure` status on a PR head, made a required check via branch
 * protection, is the soft merge gate. OAuth `repo` scope can write commit
 * statuses (unlike the Checks API, which needs a GitHub App). Throws on
 * failure — callers treat status-setting as best-effort and swallow it so
 * a flaky status call never fails the review itself.
 */
export async function postCommitStatus(
  token: string,
  repoFull: string,
  sha: string,
  opts: {
    state: 'success' | 'failure' | 'pending' | 'error';
    context: string;
    description: string;
    targetUrl?: string;
  },
): Promise<void> {
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) throw new Error(`Invalid repoFull: ${repoFull}`);
  const octokit = octokitFor(token);
  await octokit.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state: opts.state,
    context: opts.context,
    description: opts.description,
    ...(opts.targetUrl ? { target_url: opts.targetUrl } : {}),
  });
}
