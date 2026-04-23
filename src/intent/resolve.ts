import type { GH } from "../github/client.ts";
import type { Store } from "../state/db.ts";
import type { TicketContext, TicketRef } from "./types.ts";
import { extractGithubRefs, fetchGithubTicket } from "./github.ts";
import { extractJiraRefs, fetchJiraTicket } from "./jira.ts";

/**
 * Orchestrate intent resolution for a PR. Runs every configured provider's
 * extractor, dedupes refs by key, fetches in parallel, drops nulls.
 *
 * Providers enabled per-PR:
 *   github-issue  always on (uses the bot's existing PAT)
 *   jira          on only if credentials are stored for the PR's org owner
 *
 * Bounded behavior:
 *   - At most `MAX_REFS` refs per PR are fetched; excess are dropped with a
 *     log. Prevents a bug-link-heavy PR body from blowing budget.
 *   - No single fetch is retried. A failed fetch just means the ref drops;
 *     the review proceeds without that ticket's context.
 */
const MAX_REFS = 5;

export type IntentResolution = {
  tickets: TicketContext[];
  /** References we extracted but couldn't fetch — handy for debugging. */
  misses: TicketRef[];
  /** References trimmed because we hit MAX_REFS. */
  dropped: TicketRef[];
};

export async function resolveIntent(args: {
  gh: GH;
  store: Store;
  title: string;
  body: string;
  ownRepo: { owner: string; name: string };
}): Promise<IntentResolution> {
  const allRefs: TicketRef[] = [
    ...extractGithubRefs({ title: args.title, body: args.body, ownRepo: args.ownRepo }),
  ];

  const jiraCreds = args.store.getIntentCredentials(args.ownRepo.owner, "jira");
  if (jiraCreds) {
    allRefs.push(...extractJiraRefs({ title: args.title, body: args.body }));
  }

  // Dedup by key across all providers.
  const seen = new Set<string>();
  const unique: TicketRef[] = [];
  for (const r of allRefs) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    unique.push(r);
  }

  const dropped = unique.slice(MAX_REFS);
  const kept = unique.slice(0, MAX_REFS);

  const fetched = await Promise.all(
    kept.map((r) => dispatchFetch(args.gh, args.store, args.ownRepo.owner, r)),
  );

  const tickets: TicketContext[] = [];
  const misses: TicketRef[] = [];
  for (let i = 0; i < kept.length; i++) {
    const ctx = fetched[i];
    if (ctx) tickets.push(ctx);
    else misses.push(kept[i]!);
  }

  return { tickets, misses, dropped };
}

function dispatchFetch(
  gh: GH,
  store: Store,
  ownerForCreds: string,
  ref: TicketRef,
): Promise<TicketContext | null> {
  switch (ref.kind) {
    case "github-issue":
      return fetchGithubTicket(gh, ref);
    case "jira": {
      const creds = store.getIntentCredentials(ownerForCreds, "jira");
      if (!creds) return Promise.resolve(null);
      return fetchJiraTicket(creds, ref);
    }
    default:
      return Promise.resolve(null);
  }
}
