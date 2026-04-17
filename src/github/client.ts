import { Octokit } from "@octokit/rest";

export function createOctokit(pat: string, userAgent = "reviewme"): Octokit {
  return new Octokit({ auth: pat, userAgent });
}

export type { Octokit };
