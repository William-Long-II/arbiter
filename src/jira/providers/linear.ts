import type { Intent } from "../index";
import type { IntentProvider, TicketRef } from "../provider";

// Linear issue IDs look like "ENG-123" or "TEAM-456". They share the same
// format as Jira keys ([A-Z]{2,}-\d+), so provider order matters: whichever
// provider appears first in INTENT_PROVIDERS will win on ambiguous keys.
const LINEAR_ID_RE = /\b([A-Z]{2,}-\d+)\b/g;

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

type LinearIssueData = {
  identifier: string;
  title: string;
  description: string | null;
  url: string;
};

export class LinearProvider implements IntentProvider {
  readonly id = "linear";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  match(pr: { title: string; body: string }): TicketRef | null {
    const text = `${pr.title}\n${pr.body}`;
    LINEAR_ID_RE.lastIndex = 0;
    const m = LINEAR_ID_RE.exec(text);
    if (!m) return null;
    const key = m[1]!;
    return { providerId: this.id, key, raw: { key } };
  }

  async fetch(ref: TicketRef): Promise<Intent> {
    const query = `
      query IssueByIdentifier($id: String!) {
        issue(id: $id) {
          identifier
          title
          description
          url
        }
      }
    `;

    const res = await this.fetchImpl(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { id: ref.key } }),
    });

    if (!res.ok) {
      throw new Error(`Linear GraphQL request failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as {
      data?: { issue?: LinearIssueData | null };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(`Linear GraphQL error: ${json.errors[0]!.message}`);
    }

    const issue = json.data?.issue;
    if (!issue) {
      throw new Error(`Linear issue ${ref.key} not found`);
    }

    return {
      source: "linear",
      ticketKey: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      warnings: [],
    };
  }
}

/**
 * Build a LinearProvider from the environment, or return null when LINEAR_API_KEY
 * is not configured. Callers check for null before registering the provider.
 */
export function buildLinearProvider(
  fetchImpl: typeof fetch = fetch,
): LinearProvider | null {
  const key = process.env.LINEAR_API_KEY;
  if (!key) return null;
  return new LinearProvider(key, fetchImpl);
}
