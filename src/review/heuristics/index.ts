/**
 * Per-language heuristics pack for targeted review hints.
 *
 * `applicableHeuristics` inspects the file extensions in a (post-filter) diff
 * and returns the concatenated heuristic list for every detected language.
 * A mixed-language PR gets hints from every language present.
 *
 * Adding a new language requires:
 *   1. A new `src/review/heuristics/<lang>.ts` that exports `HEURISTICS: Heuristic[]`.
 *   2. A new case in the `PACKS` map below.
 * No other pipeline changes are needed.
 *
 * Heuristics are hints, not rules. The prompt instructs the LLM to look for
 * these patterns and stay silent when they are absent — false positives erode
 * trust faster than false negatives.
 */

import type { PullRequestFile } from "../../github";
import { langFromPath, type SupportedLanguage } from "../languages";
import { HEURISTICS as TS } from "./typescript";
import { HEURISTICS as PY } from "./python";
import { HEURISTICS as GO } from "./go";
import { HEURISTICS as JAVA } from "./java";

/** A single language-specific review hint. */
export type Heuristic = {
  /** Stable dot-namespaced identifier, e.g. `ts/unhandled-promise`. */
  id: string;
  /** Short phrase shown as the bullet label. */
  summary: string;
  /** Full explanation injected into the prompt. */
  hint: string;
};

/**
 * Mapping from language key to its heuristic pack.
 * Centralised here so callers never need to know which files exist.
 */
const PACKS: Record<SupportedLanguage, Heuristic[]> = {
  ts: TS,
  py: PY,
  go: GO,
  java: JAVA,
};

/**
 * Return the concatenated heuristics for every language detected in `files`.
 *
 * Files in unsupported languages produce no heuristics (no error).
 * Duplicate language packs are not emitted — each language's pack appears
 * at most once even if the diff touches many files of that language.
 *
 * @param files Post-filter `PullRequestFile` list (kept files only).
 */
export function applicableHeuristics(files: PullRequestFile[]): Heuristic[] {
  const seen = new Set<SupportedLanguage>();

  for (const file of files) {
    const lang = langFromPath(file.filename);
    if (lang !== null && lang in PACKS) {
      seen.add(lang);
    }
  }

  const result: Heuristic[] = [];
  // Emit packs in a stable order (ts → py → go → java) so golden tests are
  // deterministic regardless of file order in the diff.
  for (const lang of ["ts", "py", "go", "java"] as SupportedLanguage[]) {
    if (seen.has(lang)) {
      result.push(...PACKS[lang]);
    }
  }
  return result;
}
