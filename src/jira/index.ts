import { fetchJiraIssue, JiraFetchError, type JiraCredentials, type JiraIssue } from "./client";
import { extractTicketKey, type ExtractSources } from "./extract";
import type { IntentProvider, TicketRef } from "./provider";
import { JiraProvider } from "./providers/jira";
import type { IssueClient } from "./providers/github-issue";
import { GitHubIssueProvider } from "./providers/github-issue";
import { LinearProvider } from "./providers/linear";
import { log } from "../server/logger";

export type Intent = {
  source: "jira" | "pr-body" | "github-issue" | "linear";
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
  /** Optional: used to enable the github-issue provider. */
  octokit?: IssueClient;
  /** Optional: PR repository owner (needed to resolve bare #123 references). */
  repoOwner?: string;
  /** Optional: PR repository name (needed to resolve bare #123 references). */
  repoName?: string;
};

const KNOWN_PROVIDER_IDS = ["jira", "github-issue", "linear"] as const;

/**
 * Parse the INTENT_PROVIDERS env var into an ordered list of provider ids.
 * Falls back to all three in default order.
 */
function parseProviderList(): string[] {
  const raw = process.env.INTENT_PROVIDERS;
  if (!raw) return ["jira", "github-issue", "linear"];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => (KNOWN_PROVIDER_IDS as readonly string[]).includes(s));
}

/**
 * Produce an Intent describing what the PR is supposed to do. Iterates
 * configured intent providers in priority order; the first provider whose
 * match() returns non-null wins and its fetch() is called. Falls back to the
 * PR title + body when no provider resolves.
 *
 * Provider selection is controlled by the INTENT_PROVIDERS env var
 * (default: "jira,github-issue,linear"). Providers whose required credentials
 * are absent are silently skipped.
 */
export async function resolveIntent(
  input: ResolveIntentInput,
  /** Injected for Jira tests only; production code omits this. */
  fetchImpl: typeof fetch = fetch,
): Promise<Intent> {
  const warnings: string[] = [];

  const providerIds = parseProviderList();

  // Build providers in the configured order, skipping those whose deps are
  // missing. This deliberately preserves the order from INTENT_PROVIDERS.
  const providers: IntentProvider[] = [];
  for (const id of providerIds) {
    if (id === "jira") {
      if (input.creds) {
        providers.push(new JiraProvider(input.creds, fetchImpl));
      }
      // else: silently skip — no creds
    } else if (id === "github-issue") {
      if (input.octokit) {
        providers.push(new GitHubIssueProvider(input.octokit));
      }
      // else: silently skip — no octokit
    } else if (id === "linear") {
      const linearKey = process.env.LINEAR_API_KEY;
      if (linearKey) {
        providers.push(new LinearProvider(linearKey, fetchImpl));
      }
      // else: silently skip — no api key
    }
  }

  const prCtx = {
    title: input.prTitle,
    body: input.prBody,
    branch: input.branch,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
  };

  for (const provider of providers) {
    const ref = provider.match(prCtx);
    if (!ref) continue;

    try {
      const intent = await provider.fetch(ref);
      log.info("intent.resolved", { evt: "intent.resolved", provider: provider.id, key: ref.key });
      return { ...intent, warnings };
    } catch (err) {
      // Log the provider error and fall through to the next provider.
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("intent.provider.error", {
        evt: "intent.provider.error",
        provider: provider.id,
        key: ref.key,
        error: msg,
      });
      warnings.push(`${provider.id} fetch failed for ${ref.key}: ${msg}`);
    }
  }

  // All providers returned null or failed — fall back to PR body.
  log.info("intent.fallback", { evt: "intent.fallback" });
  return {
    source: "pr-body",
    title: input.prTitle,
    description: input.prBody,
    warnings,
  };
}

export { extractTicketKey, DEFAULT_TICKET_PATTERN } from "./extract";
export { fetchJiraIssue, JiraFetchError, type JiraCredentials, type JiraIssue } from "./client";
export { adfToText } from "./adf";
export type { IntentProvider, TicketRef } from "./provider";
