export type RereviewMode = "auto-on-sync" | "label-or-mention";

// ---------------------------------------------------------------------------
// Implicit skip — title keywords and branch prefixes
// ---------------------------------------------------------------------------

export type ImplicitSkipResult =
  | { skip: false }
  | { skip: true; reason: string };

/**
 * Decide whether a PR should be skipped based on conventional title keywords
 * or branch prefixes — without requiring an explicit /review-me skip comment.
 *
 * Title patterns (case-insensitive, matched at the start of the trimmed title):
 *   - `WIP:`, `Draft:`, `RFC:` (with optional whitespace before the colon)
 *   - `[skip-review]`, `[skip review]`, `[WIP]`, `[Draft]`
 *   - Bare `WIP` or `Draft` word at the start (e.g. "WIP my feature")
 *
 * Branch patterns (case-insensitive prefix):
 *   - `draft/…`, `wip/…`
 *
 * The `reason` field uses the coarse category (`title` or `branch`) so that
 * the Prometheus label cardinality stays bounded.
 *
 * Known limitation: the `Draft:` title keyword duplicates GitHub's native
 * `draft: true` PR flag. The explicit draft flag (handled separately upstream)
 * is more authoritative; this matcher is an English-language heuristic for
 * non-draft PRs whose authors follow the convention but skipped the draft toggle.
 */
export function shouldSkipImplicit(opts: {
  prTitle: string;
  branch: string;
}): ImplicitSkipResult {
  const trimmed = opts.prTitle.trim();

  // Title patterns — anchored at the start of the trimmed title.
  // Order: most-specific first so we match the earliest pattern.
  const TITLE_RES = [
    /^(wip|draft|rfc)\s*:/i,
    /^\[(skip[\s-]?review|wip|draft)\]/i,
    /^(wip|draft)\b/i,
  ];

  for (const re of TITLE_RES) {
    if (re.test(trimmed)) {
      return { skip: true, reason: "title" };
    }
  }

  // Branch prefix patterns.
  if (/^(draft|wip)\//i.test(opts.branch)) {
    return { skip: true, reason: "branch" };
  }

  return { skip: false };
}

export type CheckSuiteDecision =
  | { proceed: true }
  | { proceed: false; reason: string };

/**
 * Decide whether a CI-green signal should trigger a review based on the
 * repo's re-review mode and the PR's prior-review state.
 *
 * - `auto-on-sync` always proceeds.
 * - `label-or-mention` proceeds for the FIRST review (no prior review by
 *   the bot on any SHA), then waits for a label or a /review-me mention on
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
    reason: "label-or-mention mode: awaiting rereview label or /review-me",
  };
}

const MENTION_RE = /(^|\s)\/review-me(\s|$)/;

export function mentionsReviewCommand(body: string | null | undefined): boolean {
  if (!body) return false;
  return MENTION_RE.test(body);
}

// ---------------------------------------------------------------------------
// Slash-command parser
// ---------------------------------------------------------------------------

export type SlashCommandName =
  | "help"
  | "skip"
  | "resume"
  | "re-review"
  | "refresh"
  | "unknown";

export type SlashCommand = {
  command: SlashCommandName;
  /** The raw matched text (e.g. "/review-me skip"). */
  raw: string;
};

/**
 * Parse the first `/review-me [subcommand]` found at the start of any line
 * (leading whitespace allowed, case-insensitive subcommand).
 *
 * - `/review-me help`       → { command: "help" }
 * - `/review-me skip`       → { command: "skip" }
 * - `/review-me resume`     → { command: "resume" }
 * - `/review-me re-review`  → { command: "re-review" }
 * - `/review-me refresh`    → { command: "refresh" }
 * - `/review-me`            → { command: "re-review" }  (bare mention = re-review)
 * - `/review-me foo`        → { command: "unknown" }
 *
 * Returns null when no `/review-me` appears at a line boundary.
 * Never throws.
 */
export function parseSlashCommand(
  body: string | null | undefined,
): SlashCommand | null {
  if (!body) return null;

  // Match at start-of-string or after a newline, with optional leading spaces.
  // Capture the optional subcommand word after the slash command.
  // The subcommand is separated by one or more spaces; only the first word
  // is used as the command name (args are not parsed further).
  const re =
    /(?:^|\n)[ \t]*\/review-me(?:[ \t]+([^\s\n]+))?[ \t]*(?:\n|$)/i;

  const match = re.exec(body);
  if (!match) return null;

  // Reconstruct the raw matched portion (trim surrounding whitespace).
  const subcommand = match[1];
  const rawSuffix = subcommand ? ` ${subcommand}` : "";
  const raw = `/review-me${rawSuffix}`;

  if (!subcommand) {
    // Bare /review-me → implicit re-review
    return { command: "re-review", raw };
  }

  const lower = subcommand.toLowerCase();
  switch (lower) {
    case "help":
      return { command: "help", raw };
    case "skip":
      return { command: "skip", raw };
    case "resume":
      return { command: "resume", raw };
    case "re-review":
      return { command: "re-review", raw };
    case "refresh":
      return { command: "refresh", raw };
    default:
      return { command: "unknown", raw };
  }
}
