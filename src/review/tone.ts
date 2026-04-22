import type { Config } from "../config.ts";

/**
 * Resolve the final tone string that should be sent to Claude for a given
 * repo. Precedence: repo > org > default. Each level is either APPEND
 * (the override is added after the inherited tone) or REPLACE (the override
 * wipes everything above it and becomes the entire tone).
 *
 * A null override means "inherit from the next level up" regardless of mode.
 * An empty-string override with mode=replace is a valid way to silence the
 * default entirely.
 */
export function resolveTone(args: {
  cfg: Config;
  owner: string;
  name: string;
}): string {
  const slug = `${args.owner}/${args.name}`.toLowerCase();

  const repo = args.cfg.watch.repos.find((r) => r.slug.toLowerCase() === slug);
  const org = args.cfg.watch.orgs.find(
    (o) => o.name.toLowerCase() === args.owner.toLowerCase(),
  );

  const defaultTone = args.cfg.review.tone ?? "";

  // Start with the org layer: either inherits default, appends to it, or replaces it.
  let base: string;
  if (!org || org.tone_override === null) {
    base = defaultTone;
  } else if (org.tone_mode === "replace") {
    base = org.tone_override;
  } else {
    base = joinAppend(defaultTone, org.tone_override);
  }

  // Apply the repo layer on top.
  if (!repo || repo.tone_override === null) return base;
  if (repo.tone_mode === "replace") return repo.tone_override;
  return joinAppend(base, repo.tone_override);
}

function joinAppend(base: string, extra: string): string {
  const a = base.trim();
  const b = extra.trim();
  if (!a) return b;
  if (!b) return a;
  return `${a}\n\nAdditional guidance for this repository:\n${b}`;
}
