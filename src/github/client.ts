import { Octokit } from "@octokit/rest";

export function makeClient(token: string): Octokit {
  return new Octokit({
    auth: token,
    userAgent: "auto-reviewer",
    request: { timeout: 30_000 },
  });
}

export type GH = Octokit;
