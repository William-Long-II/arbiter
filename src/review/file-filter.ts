import type { FileDiff } from "../github/diff.ts";

/**
 * Default exclude list seeded into config_scalars on first boot. Captures the
 * classic "Claude was reading a 2MB yarn.lock" cases — these paths rarely
 * benefit from an LLM review and blow up prompt size dramatically.
 *
 * Users can remove any of these in the UI; the list is just a starting
 * point, not an unremovable policy.
 */
export const DEFAULT_EXCLUDE_PATHS: string[] = [
  // Dependency lockfiles
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/poetry.lock",
  "**/Pipfile.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/Cargo.lock",
  "**/go.sum",
  // Minified / generated artifacts
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  // Third-party / generated directories
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/__generated__/**",
  "**/*.generated.*",
];

/**
 * Decide which files Claude should actually see.
 *
 * Semantics:
 *  - `include` empty = every file passes the include check. A non-empty
 *    include list means ONLY those files pass (whitelist mode).
 *  - `exclude` applies after include; any match drops the file.
 *
 * Glob syntax is whatever Bun.Glob accepts (minimatch-compatible): `*` for
 * intra-segment wildcards, `**` for cross-segment. Case-sensitive.
 */
export function filterFiles(
  files: FileDiff[],
  include: string[],
  exclude: string[],
): { kept: FileDiff[]; skipped: { file: FileDiff; reason: "not_included" | "excluded"; pattern: string }[] } {
  const includeGlobs = include.map((p) => ({ pattern: p, glob: new Bun.Glob(p) }));
  const excludeGlobs = exclude.map((p) => ({ pattern: p, glob: new Bun.Glob(p) }));

  const kept: FileDiff[] = [];
  const skipped: { file: FileDiff; reason: "not_included" | "excluded"; pattern: string }[] = [];

  for (const file of files) {
    if (includeGlobs.length > 0) {
      const matched = includeGlobs.find((g) => g.glob.match(file.path));
      if (!matched) {
        skipped.push({ file, reason: "not_included", pattern: "" });
        continue;
      }
    }

    const hit = excludeGlobs.find((g) => g.glob.match(file.path));
    if (hit) {
      skipped.push({ file, reason: "excluded", pattern: hit.pattern });
      continue;
    }

    kept.push(file);
  }

  return { kept, skipped };
}
