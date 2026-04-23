/**
 * Intent resolution — fetch the ticket / issue a PR refers to so Claude can
 * review against "does this code do what the ticket asked" instead of just
 * "does the code look clean."
 *
 * Each provider is responsible for:
 *   extract()  — find its references in the PR's title + body
 *   fetch()    — turn a reference into a TicketContext (or null on miss)
 *
 * The orchestrator in resolve.ts runs all configured providers, dedupes,
 * and returns a flat list. When no providers find anything the return is
 * an empty array — Claude just doesn't see a TICKET CONTEXT block.
 */

export type TicketKind = "github-issue" | "jira";
// Future: "linear";

export type TicketRef = {
  kind: TicketKind;
  /** A stable identifier for dedup — "owner/repo#123" for GH, "PROJ-123" for Jira, etc. */
  key: string;
  /** The raw string as it appeared in the PR (e.g. "#123" or "owner/repo#5"). */
  raw: string;
  /** Provider-specific locator fields. Resolver destructures per-kind. */
  owner?: string;
  repoName?: string;
  number?: number;
};

export type TicketContext = {
  kind: TicketKind;
  key: string;
  title: string;
  body: string;
  url: string;
  /** Sometimes GitHub issues are really PRs (same number space). Surface both so Claude knows. */
  isPullRequest?: boolean;
};
