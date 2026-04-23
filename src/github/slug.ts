/**
 * GitHub repo slug (`"owner/name"`) parse + format.
 *
 * Centralizes what used to be six inline `slug.split("/")` calls across the
 * codebase, each of which silently produced `name === undefined` when the
 * input wasn't well-formed. That `undefined` then propagated into URLs and
 * GitHub API calls as the literal string "undefined". parseSlug returns
 * null on any malformed input so callers are forced to handle the case.
 */
export type Slug = { owner: string; name: string };

export function parseSlug(s: string): Slug | null {
  if (typeof s !== "string") return null;
  const parts = s.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name) return null;
  return { owner, name };
}

export function formatSlug(slug: Slug): string {
  return `${slug.owner}/${slug.name}`;
}

/**
 * Encode an "owner/name" slug as TWO path segments. Doing
 * `encodeURIComponent("owner/name")` produces `"owner%2Fname"` which the
 * server's `:owner/:name` route matcher reads as one segment — that bug
 * cost an entire PR (#109) to fix the first time, so the helper exists
 * to keep it from coming back.
 */
export function sluggedPath(slug: string): string {
  const parsed = parseSlug(slug);
  if (!parsed) return "";
  return `${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`;
}
