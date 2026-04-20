import { fetchJiraIssue, type JiraCredentials } from "../client";
import { extractTicketKey, DEFAULT_TICKET_PATTERN } from "../extract";
import type { Intent } from "../index";
import type { IntentProvider, TicketRef } from "../provider";

export class JiraProvider implements IntentProvider {
  readonly id = "jira";

  constructor(
    private readonly creds: JiraCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  match(pr: { title: string; body: string; branch?: string }): TicketRef | null {
    const key = extractTicketKey(
      { title: pr.title, branch: pr.branch, body: pr.body },
      DEFAULT_TICKET_PATTERN,
    );
    if (!key) return null;
    return { providerId: this.id, key, raw: { key } };
  }

  async fetch(ref: TicketRef): Promise<Intent> {
    const issue = await fetchJiraIssue(this.creds, ref.key, this.fetchImpl);
    return {
      source: "jira",
      ticketKey: issue.key,
      title: issue.summary,
      description: issue.description,
      warnings: [],
    };
  }
}
