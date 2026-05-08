// Octokit wrapper — stub. Provides a typed factory bound to a user's OAuth token.
import { Octokit } from '@octokit/rest';

export function octokitFor(token: string): Octokit {
  return new Octokit({ auth: token });
}

// Shape of a PR row we care about, projected from GitHub's response.
export type PRMeta = {
  repoFull: string;
  number: number;
  title: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  draft: boolean;
};
