import type { IntentCredentials } from "../state/db.ts";
import type { TicketContext, TicketRef } from "./types.ts";

/**
 * Jira Cloud provider.
 *
 * Extraction: word-bounded `[A-Z][A-Z0-9]+-\d+`. The project part must be
 * at least two characters (single-letter projects exist but are rare, and
 * allowing 1 char produces a lot of false matches — `a-1`, `b-2` etc).
 *
 * Fetch: GET /rest/api/2/issue/{key}?fields=summary,description.
 * v2 returns description as ADF (a JSON content tree), same as v3. We flatten
 * to plain text. Using v2 keeps us away from the v3 expand=renderedFields
 * HTML path that would require HTML-stripping.
 *
 * Auth: Basic email + API token. That's Atlassian Cloud's standard auth.
 * Server/DC Jira (still around at some shops) uses personal access tokens
 * in Bearer — out of scope for this phase.
 */

// [A-Z][A-Z0-9]+-\d+  with word boundaries
const JIRA_RE = /\b([A-Z][A-Z0-9]+)-(\d+)\b/g;

export function extractJiraRefs(args: { title: string; body: string }): TicketRef[] {
  const seen = new Set<string>();
  const out: TicketRef[] = [];
  const haystack = `${args.title}\n${args.body}`;
  for (const m of haystack.matchAll(JIRA_RE)) {
    const project = m[1]!;
    const number = Number(m[2]);
    if (!Number.isInteger(number) || number <= 0) continue;
    const key = `${project}-${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: "jira",
      key,
      raw: m[0]!,
    });
  }
  return out;
}

const FETCH_TIMEOUT_MS = 8_000;

export async function fetchJiraTicket(
  creds: IntentCredentials,
  ref: TicketRef,
): Promise<TicketContext | null> {
  if (ref.kind !== "jira") return null;
  if (!creds.host || !creds.email || !creds.api_token) return null;

  const host = creds.host.replace(/\/+$/, "");
  const url = `${host}/rest/api/2/issue/${encodeURIComponent(ref.key)}?fields=summary,description`;
  const auth = "Basic " + Buffer.from(`${creds.email}:${creds.api_token}`, "utf8").toString("base64");

  try {
    const res = await fetch(url, {
      headers: {
        authorization: auth,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      fields?: { summary?: string; description?: unknown };
    };
    const title = data.fields?.summary ?? "";
    const body = adfToText(data.fields?.description).trim();
    const browseUrl = `${host}/browse/${encodeURIComponent(ref.key)}`;
    return {
      kind: "jira",
      key: ref.key,
      title,
      body,
      url: browseUrl,
    };
  } catch {
    return null;
  }
}

/**
 * Flatten Atlassian Document Format (the JSON tree Jira returns for
 * rich-text fields) into plain text. Handles paragraphs, headings, lists,
 * line breaks. Unknown node types are walked for children but contribute
 * nothing themselves. Good-enough for injecting into a Claude prompt;
 * not a faithful renderer.
 */
export function adfToText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown };

  // Leaf text nodes
  if (n.type === "text" && typeof n.text === "string") return n.text;
  if (n.type === "hardBreak") return "\n";

  const children = Array.isArray(n.content)
    ? n.content.map((c) => adfToText(c)).join("")
    : "";

  switch (n.type) {
    case "paragraph":
    case "heading":
      return children + "\n\n";
    case "listItem":
      return "- " + children.replace(/\n+$/, "") + "\n";
    case "bulletList":
    case "orderedList":
      return children + "\n";
    case "codeBlock":
      return "```\n" + children + "```\n\n";
    default:
      // doc node and any unknown wrappers just pass through their children
      return children;
  }
}
