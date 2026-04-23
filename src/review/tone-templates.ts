import type { FileDiff } from "../github/diff.ts";

/**
 * Per-file-type tone templates. The loop runs the normal tone resolution
 * (default → org → repo), then walks the configured templates and appends
 * the tone_addendum of every template whose glob matches at least one
 * changed file in the PR.
 *
 * Ordering: ascending by priority. Lower-priority addendums are appended
 * first; higher-priority addendums come later in the final tone block so
 * they appear closer to the TASK line — prompting has a mild recency
 * effect, so "more specific guidance wins" maps to "higher priority".
 *
 * Ties (same priority) fall back to insertion order (stable sort).
 */
export type ToneTemplate = {
  id: number;
  pattern: string;
  tone_addendum: string;
  priority: number;
};

export type TemplateMatch = {
  id: number;
  pattern: string;
  priority: number;
  /** Up to 20 matched file paths — plenty for the detail page; larger PRs truncate. */
  matched_paths: string[];
  /** Total matched count (may be > matched_paths.length when truncated). */
  matched_count: number;
};

export function applyToneTemplates(args: {
  baseTone: string;
  files: FileDiff[];
  templates: ToneTemplate[];
}): { tone: string; applied: TemplateMatch[] } {
  const { baseTone, files, templates } = args;
  if (templates.length === 0) return { tone: baseTone, applied: [] };

  const ordered = [...templates].sort((a, b) => a.priority - b.priority);
  const applied: TemplateMatch[] = [];
  const addendums: string[] = [];

  for (const t of ordered) {
    const glob = new Bun.Glob(t.pattern);
    const matches: string[] = [];
    for (const f of files) {
      if (glob.match(f.path)) matches.push(f.path);
    }
    if (matches.length === 0) continue;
    applied.push({
      id: t.id,
      pattern: t.pattern,
      priority: t.priority,
      matched_paths: matches.slice(0, 20),
      matched_count: matches.length,
    });
    const trimmed = t.tone_addendum.trim();
    if (trimmed) addendums.push(trimmed);
  }

  if (addendums.length === 0) return { tone: baseTone, applied };

  const header = "Additional guidance for file types in this PR:";
  const extra = `${header}\n${addendums.map((a) => `- ${a}`).join("\n")}`;
  const base = baseTone.trim();
  const tone = base ? `${base}\n\n${extra}` : extra;
  return { tone, applied };
}
