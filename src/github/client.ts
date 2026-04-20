import { Octokit } from "@octokit/rest";
import { withRetry, type RetryOptions } from "../util/retry";

export function createOctokit(pat: string, userAgent = "review-me"): Octokit {
  return new Octokit({ auth: pat, userAgent });
}

/**
 * Wrap a single GitHub API call with retry/backoff.
 *
 * Use this at every Octokit call-site inside `src/github/` in place of calling
 * the Octokit method directly.  All retry policy lives in `src/util/retry.ts`;
 * this is just a thin convenience that provides a GitHub-appropriate default.
 */
export function withGitHubRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  return withRetry(fn, options);
}

export type { Octokit };
