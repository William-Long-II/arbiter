import { fetchJiraIssue, JiraFetchError, type JiraCredentials, type JiraIssue } from "./client";
import { extractTicketKey, type ExtractSources } from "./extract";

export type Intent = {
  source: "jira" | "pr-body";
  ticketKey?: string;
  title: string;
  description: string;
  warnings: string[];
};

export type ResolveIntentInput = {
  prTitle: string;
  prBody: string;
  branch: string;
  creds?: JiraCredentials;
};

/**
 * Produce an Intent describing what the PR is supposed to do. Prefers a
 * linked Jira ticket; falls back to the PR title + body and records why.
 */
export async function resolveIntent(
  input: ResolveIntentInput,
  fetchImpl: typeof fetch = fetch,
): Promise<Intent> {
  const warnings: string[] = [];
  const ticketKey = extractTicketKey({
    title: input.prTitle,
    branch: input.branch,
    body: input.prBody,
  });

  if (!ticketKey) {
    warnings.push("no jira ticket key found in PR title, branch, or body");
    return fallback(input, warnings);
  }

  if (!input.creds) {
    warnings.push(
      `found ticket key ${ticketKey} but jira credentials are not configured`,
    );
    return fallback(input, warnings, ticketKey);
  }

  let issue: JiraIssue;
  try {
    issue = await fetchJiraIssue(input.creds, ticketKey, fetchImpl);
  } catch (err) {
    const msg = err instanceof JiraFetchError ? err.message : String(err);
    warnings.push(`jira fetch failed for ${ticketKey}: ${msg}`);
    return fallback(input, warnings, ticketKey);
  }

  return {
    source: "jira",
    ticketKey: issue.key,
    title: issue.summary,
    description: issue.description,
    warnings,
  };
}

function fallback(
  input: ResolveIntentInput,
  warnings: string[],
  ticketKey?: string,
): Intent {
  return {
    source: "pr-body",
    ticketKey,
    title: input.prTitle,
    description: input.prBody,
    warnings,
  };
}

export { extractTicketKey, DEFAULT_TICKET_PATTERN } from "./extract";
export { fetchJiraIssue, JiraFetchError, type JiraCredentials, type JiraIssue } from "./client";
export { adfToText } from "./adf";
