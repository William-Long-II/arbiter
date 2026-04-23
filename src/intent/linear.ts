import type { IntentCredentials } from "../state/db.ts";
import type { TicketContext, TicketRef } from "./types.ts";

/**
 * Linear provider.
 *
 * Extraction: same `[A-Z][A-Z0-9]+-\d+` shape as Jira — Linear identifiers
 * look like `ENG-123`, `OPS-45`. If both Jira and Linear are configured for
 * an org, each extractor emits its own ref and both fetches happen. The
 * resolver dedupes by `${kind}:${key}` so identical ref strings across
 * providers both get their shot.
 *
 * Fetch: Linear's GraphQL endpoint with a personal API key in the plain
 * `Authorization` header (no Bearer prefix — that's OAuth). The `issue(id:)`
 * resolver accepts either the UUID or the human identifier ("ENG-123"), so
 * one round-trip gets us the full ticket.
 *
 * Description is plain Markdown in Linear's API (unlike Jira's ADF tree),
 * which is already fine to inject into a prompt as-is.
 */

const LINEAR_RE = /\b([A-Z][A-Z0-9]+)-(\d+)\b/g;
const FETCH_TIMEOUT_MS = 8_000;
const LINEAR_ENDPOINT = "https://api.linear.app/graphql";

export function extractLinearRefs(args: { title: string; body: string }): TicketRef[] {
  const seen = new Set<string>();
  const out: TicketRef[] = [];
  const haystack = `${args.title}\n${args.body}`;
  for (const m of haystack.matchAll(LINEAR_RE)) {
    const project = m[1]!;
    const number = Number(m[2]);
    if (!Number.isInteger(number) || number <= 0) continue;
    const key = `${project}-${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "linear", key, raw: m[0]! });
  }
  return out;
}

const QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    identifier
    title
    description
    url
  }
}`;

export async function fetchLinearTicket(
  creds: IntentCredentials,
  ref: TicketRef,
): Promise<TicketContext | null> {
  if (ref.kind !== "linear") return null;
  if (!creds.api_token) return null;

  try {
    const res = await fetch(LINEAR_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Linear personal API keys go in Authorization with NO "Bearer" prefix.
        // OAuth tokens use Bearer; we're personal-key only here.
        authorization: creds.api_token,
      },
      body: JSON.stringify({ query: QUERY, variables: { id: ref.key } }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: { issue?: { identifier?: string; title?: string; description?: string | null; url?: string } };
      errors?: unknown;
    };
    const issue = data.data?.issue;
    if (!issue) return null;
    return {
      kind: "linear",
      key: issue.identifier ?? ref.key,
      title: issue.title ?? "",
      body: (issue.description ?? "").trim(),
      url: issue.url ?? `https://linear.app/issue/${encodeURIComponent(ref.key)}`,
    };
  } catch {
    return null;
  }
}
