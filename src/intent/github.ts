import type { GH } from "../github/client.ts";
import type { TicketContext, TicketRef } from "./types.ts";

/**
 * GitHub issue / cross-repo-issue extraction + fetch.
 *
 * Patterns matched:
 *   #123              — same repo as the PR
 *   owner/repo#123    — cross-repo reference
 *
 * Edge cases:
 *   "#123" inside a code fence or autolink is still extracted — GitHub
 *   renders them as links, so they're referenced from the reviewer's
 *   perspective. Over-extraction is cheap; we dedupe and the fetch
 *   simply returns null for anything that isn't an issue/PR.
 */

// Group 1 = full owner/repo (optional). Group 2 = owner. Group 3 = repo. Group 4 = number.
// Owner/repo chars: GitHub allows alphanumerics + hyphen, dot, underscore.
const REF_RE = /(?:([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*))?#(\d+)/g;

export function extractGithubRefs(args: {
  title: string;
  body: string;
  ownRepo: { owner: string; name: string };
}): TicketRef[] {
  const seen = new Set<string>();
  const out: TicketRef[] = [];
  const haystack = `${args.title}\n${args.body}`;
  for (const m of haystack.matchAll(REF_RE)) {
    const owner = m[1] ?? args.ownRepo.owner;
    const repoName = m[2] ?? args.ownRepo.name;
    const number = Number(m[3]);
    if (!Number.isInteger(number) || number <= 0) continue;
    const key = `${owner}/${repoName}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: "github-issue",
      key,
      raw: m[0]!,
      owner,
      repoName,
      number,
    });
  }
  return out;
}

/**
 * Fetch one GitHub issue/PR. Returns null on 404 or other failures — the
 * caller logs; we don't want a missing ticket to abort the review.
 */
export async function fetchGithubTicket(
  gh: GH,
  ref: TicketRef,
): Promise<TicketContext | null> {
  if (ref.kind !== "github-issue") return null;
  const owner = ref.owner;
  const name = ref.repoName;
  const number = ref.number;
  if (!owner || !name || number === undefined) return null;
  try {
    const res = await gh.issues.get({
      owner,
      repo: name,
      issue_number: number,
    });
    const data = res.data;
    return {
      kind: "github-issue",
      key: ref.key,
      title: data.title,
      body: (data.body ?? "").trim(),
      url: data.html_url,
      isPullRequest: "pull_request" in data && !!data.pull_request,
    };
  } catch {
    return null;
  }
}
