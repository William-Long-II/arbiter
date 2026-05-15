// Octokit factory bound to a user's OAuth token. The projected PR shapes
// live with their consumers: PRDetails in github/pulls.ts is the canonical
// one.
import { Octokit } from '@octokit/rest';

export function octokitFor(token: string): Octokit {
  return new Octokit({ auth: token });
}
