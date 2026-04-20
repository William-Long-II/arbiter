/**
 * Shared language detection helper.
 *
 * Both `coverage-delta.ts` (symbol extraction) and `heuristics/index.ts`
 * (per-language review hints) need to map a file path to a language key.
 * This module is the single source of truth so neither duplicates the logic.
 *
 * Why a separate module rather than exporting from coverage-delta.ts:
 * coverage-delta.ts already has a stable public API and importing from it
 * would create a coupling between the heuristics feature and the coverage
 * feature. A shared utility avoids that.
 */

/** Language keys used across the review pipeline. */
export type SupportedLanguage = "ts" | "py" | "go" | "java";

/**
 * Map a file path to its language key, or `null` when unsupported.
 *
 * Extension rules (case-insensitive after the last dot):
 * - .ts, .tsx, .js, .jsx, .mjs, .cjs → "ts"
 * - .py, .pyi                         → "py"
 * - .go (but not .pb.go generated)    → "go"  (caller filters generated paths)
 * - .java                             → "java"
 *
 * Note: generated-file filtering (vendor/, dist/, .pb.go, etc.) is handled
 * upstream by `classifyFile`; this helper only maps extension → language.
 */
export function langFromPath(path: string): SupportedLanguage | null {
  const basename = path.split("/").pop() ?? path;
  const dotIdx = basename.lastIndexOf(".");
  if (dotIdx < 0) return null;
  const ext = basename.slice(dotIdx + 1).toLowerCase();

  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "ts";
    case "py":
    case "pyi":
      return "py";
    case "go":
      return "go";
    case "java":
      return "java";
    default:
      return null;
  }
}
