import { adfToText } from "./adf";
import { withRetry } from "../util/retry";

export type JiraCredentials = {
  baseUrl: string;
  email: string;
  apiToken: string;
};

export type JiraIssue = {
  key: string;
  summary: string;
  description: string;
};

export class JiraFetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "JiraFetchError";
  }
}

async function fetchJiraIssueOnce(
  creds: JiraCredentials,
  key: string,
  fetchImpl: typeof fetch,
): Promise<JiraIssue> {
  const auth = Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64");
  const url = `${creds.baseUrl.replace(/\/$/, "")}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description`;

  const res = await fetchImpl(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new JiraFetchError(
      `jira fetch failed: ${res.status} ${res.statusText}`,
      res.status,
    );
  }

  const json = (await res.json()) as {
    key: string;
    fields: { summary?: string; description?: unknown };
  };

  return {
    key: json.key,
    summary: json.fields.summary ?? "",
    description: adfToText(json.fields.description).trim(),
  };
}

export async function fetchJiraIssue(
  creds: JiraCredentials,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraIssue> {
  return withRetry(() => fetchJiraIssueOnce(creds, key, fetchImpl));
}
