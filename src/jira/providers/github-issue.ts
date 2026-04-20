import type { Intent } from "../index";
import type { IntentProvider, TicketRef } from "../provider";

// Matches: fixes #123, closes #123, resolves #123, fixes owner/repo#123
// Case-insensitive. Captures optional cross-repo prefix and the issue number.
const CLOSING_KEYWORD_RE =
  /(?:fixes|closes|resolves)\s+(?:([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)#|#)(\d+)/gi;

type GithubRef = {
  owner: string;
  repo: string;
  number: number;
};

// Minimal Octokit-compatible interface so we can accept the real Octokit or a
// lightweight mock without importing the full type.
export interface IssueClient {
  issues: {
    get(params: {
      owner: string;
      repo: string;
      issue_number: number;
    }): Promise<{
      data: {
        number: number;
        title: string;
        body: string | null;
        html_url: string;
      };
    }>;
  };
}

export class GitHubIssueProvider implements IntentProvider {
  readonly id = "github-issue";

  constructor(private readonly octokit: IssueClient) {}

  match(pr: {
    title: string;
    body: string;
    repoOwner?: string;
    repoName?: string;
  }): TicketRef | null {
    const text = `${pr.title}\n${pr.body}`;
    CLOSING_KEYWORD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLOSING_KEYWORD_RE.exec(text)) !== null) {
      const crossRepoPrefix = m[1]; // e.g. "owner/repo" or undefined
      const issueNumber = parseInt(m[2]!, 10);

      let owner: string;
      let repo: string;
      if (crossRepoPrefix) {
        const parts = crossRepoPrefix.split("/");
        owner = parts[0]!;
        repo = parts[1]!;
      } else if (pr.repoOwner && pr.repoName) {
        owner = pr.repoOwner;
        repo = pr.repoName;
      } else {
        // No repo context; skip this match
        continue;
      }

      const ref: GithubRef = { owner, repo, number: issueNumber };
      const key = `${owner}/${repo}#${issueNumber}`;
      return { providerId: this.id, key, raw: ref };
    }
    return null;
  }

  async fetch(ref: TicketRef): Promise<Intent> {
    const ghRef = ref.raw as GithubRef;
    const { data } = await this.octokit.issues.get({
      owner: ghRef.owner,
      repo: ghRef.repo,
      issue_number: ghRef.number,
    });

    return {
      source: "github-issue",
      ticketKey: `#${data.number}`,
      title: data.title,
      description: data.body ?? "",
      warnings: [],
    };
  }
}
