export const DEFAULT_TICKET_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/;

export type ExtractSources = {
  title?: string;
  branch?: string;
  body?: string;
};

/**
 * Find the first ticket key in (priority order) title, branch, body.
 * Branch names often use lowercase (e.g. feature/proj-123-foo), so we
 * also test uppercased branch text.
 */
export function extractTicketKey(
  sources: ExtractSources,
  pattern: RegExp = DEFAULT_TICKET_PATTERN,
): string | undefined {
  const candidates: string[] = [
    sources.title ?? "",
    (sources.branch ?? "").toUpperCase(),
    sources.body ?? "",
  ];
  for (const candidate of candidates) {
    const match = candidate.match(pattern);
    if (match) return match[0];
  }
  return undefined;
}
