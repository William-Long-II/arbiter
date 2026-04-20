export type RereviewMode = "auto-on-sync" | "label-or-mention";

export type CheckSuiteDecision =
  | { proceed: true }
  | { proceed: false; reason: string };

/**
 * Decide whether a CI-green signal should trigger a review based on the
 * repo's re-review mode and the PR's prior-review state.
 *
 * - `auto-on-sync` always proceeds.
 * - `label-or-mention` proceeds for the FIRST review (no prior review by
 *   the bot on any SHA), then waits for a label or a /reviewme mention on
 *   subsequent pushes.
 */
export function decideFromCheckSuite(
  mode: RereviewMode,
  hasPriorReview: boolean,
  hasRereviewLabel: boolean,
): CheckSuiteDecision {
  if (mode === "auto-on-sync") return { proceed: true };
  if (!hasPriorReview) return { proceed: true };
  if (hasRereviewLabel) return { proceed: true };
  return {
    proceed: false,
    reason: "label-or-mention mode: awaiting rereview label or /reviewme",
  };
}

const MENTION_RE = /(^|\s)\/reviewme(\s|$)/;

export function mentionsReviewCommand(body: string | null | undefined): boolean {
  if (!body) return false;
  return MENTION_RE.test(body);
}
