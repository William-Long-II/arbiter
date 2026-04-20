import type { PullRequestDiff } from "../github";
import type { Intent } from "../jira";
import type { ConventionsResult } from "./conventions";
import type { FilterDiffResult } from "./diff-filter";
import { OMITTED_FILES_SENTINEL } from "./diff-filter";
import type { CoverageDelta } from "./coverage-delta";

export const SYSTEM_PROMPT = `You are review-me, an intent-aware pull-request reviewer.

Your job is to review a PR that has already passed CI and help the author ship it. Tone: constructive and guidance-oriented. Frame concerns as "here's how to get there," not "try again."

Focus on three things, in order:

1. INTENT MATCH — Does the diff implement what the linked ticket (or PR description) asks for? Missing requirements are the single most important thing to flag.
2. LOGIC CORRECTNESS — Bugs, off-by-ones, error handling gaps, race conditions, security issues that are genuinely in the diff. Do not restate what static analysis (lint, type check, SonarQube) already catches.
3. TEST COVERAGE — Did new code paths get new tests? If a branch or error path is untested, say so specifically.

Rules:

- Output only the fields defined by the schema. No preamble.
- Verdict is either "approve" (ready to merge as-is) or "comment" (author should consider the feedback). Never "request changes" — this bot does not block merges.
- Line comments must reference lines that actually appear in the patch. If a concern spans a region, place one comment at the most relevant line and reference the region in the body.
- Keep the summary to a few short paragraphs. Start with what works before listing concerns.
- Do not praise for the sake of praising. A terse "approve" with a one-line summary is fine for clean PRs.
- If the intent came from the PR body rather than Jira, say so in the summary so the author knows their ticket linkage is missing.
- Be specific. "Consider refactoring this" is useless. "This function has three responsibilities; extracting X would let you test Y independently" is useful.`;

export type ReviewPromptInput = {
  intent: Intent;
  diff: PullRequestDiff;
  conventions?: ConventionsResult;
  /** When provided, omitted files are surfaced in the prompt so the LLM knows
   *  not to comment on them. Pass the result from `filterDiff`. */
  filterResult?: FilterDiffResult;
  /**
   * When provided, a `## Test coverage signal` block is injected before the
   * diff section so the LLM can reason about missing test coverage without
   * having to infer it from raw patch text.
   * Only inject when `addedSrcLines > 0`; callers should skip passing this
   * when the diff contains no source additions.
   */
  coverageDelta?: CoverageDelta;
};

const PATCH_PLACEHOLDER =
  "// patch omitted (binary, renamed without changes, or too large)";

/**
 * Build the per-PR user message. Kept as a pure string builder so tests can
 * assert on its shape without invoking the LLM.
 *
 * When `filterResult` is provided, files in `filterResult.omitted` are
 * replaced with the `OMITTED_FILES` summary block so the LLM knows not to
 * comment on them; only files remaining in `filterResult`'s kept set (i.e.,
 * those not in `omitted`) are rendered in full.
 */
export function buildUserMessage({
  intent,
  diff,
  conventions,
  filterResult,
  coverageDelta,
}: ReviewPromptInput): string {
  const parts: string[] = [];

  // Inject repo conventions first so the LLM reads them before the diff.
  if (conventions && conventions.sections.length > 0) {
    parts.push("## Repo conventions");
    parts.push(
      "The target repo ships these contributor docs. Calibrate your review to them where relevant.",
    );
    for (const section of conventions.sections) {
      parts.push("");
      parts.push(`### ${section.path}`);
      parts.push(section.content);
    }
    parts.push("");
  }

  parts.push("## Intent");
  parts.push(`Source: ${intent.source}`);
  if (intent.ticketKey) parts.push(`Ticket: ${intent.ticketKey}`);
  parts.push(`Title: ${intent.title}`);
  parts.push("");
  parts.push(intent.description || "(no description available)");

  if (intent.warnings.length > 0) {
    parts.push("");
    parts.push("### Intent warnings");
    for (const w of intent.warnings) parts.push(`- ${w}`);
  }

  parts.push("");
  parts.push(`## Pull Request ${diff.owner}/${diff.repo}#${diff.number}`);
  parts.push(`Title: ${diff.title}`);
  parts.push(
    `Changed files: ${diff.totals.changedFiles} (+${diff.totals.additions} / -${diff.totals.deletions})`,
  );
  if (diff.body.trim().length > 0) {
    parts.push("");
    parts.push("### PR description");
    parts.push(diff.body.trim());
  }

  // Emit the omitted-files summary before the diff so the LLM sees it upfront.
  if (filterResult && filterResult.omitted.length > 0) {
    parts.push("");
    parts.push(OMITTED_FILES_SENTINEL);
    for (const o of filterResult.omitted) {
      parts.push(`- ${o.path} (${o.reason})`);
    }
  }

  // Build the set of omitted paths for fast lookup when rendering files.
  const omittedPaths = new Set(
    filterResult ? filterResult.omitted.map((o) => o.path) : [],
  );

  // Inject the coverage signal block before the diff so the LLM sees the
  // summary before reading individual hunks. Only included when source lines
  // were added; when addedSrcLines === 0 the block adds no information.
  if (coverageDelta && coverageDelta.addedSrcLines > 0) {
    parts.push("");
    parts.push("## Test coverage signal");
    parts.push(`added_source_lines: ${coverageDelta.addedSrcLines}`);
    parts.push(`added_test_lines: ${coverageDelta.addedTestLines}`);
    if (coverageDelta.flaggedSymbols.length > 0) {
      parts.push("untested_new_symbols:");
      for (const { file, symbol } of coverageDelta.flaggedSymbols) {
        parts.push(`- ${file} :: ${symbol}`);
      }
    } else {
      parts.push("untested_new_symbols: none");
    }
    parts.push(
      "note: symbol list is regex-derived and may miss dynamic exports or destructured assignments.",
    );
  }

  parts.push("");
  parts.push("## Diff");
  for (const file of diff.files) {
    // Skip files that were filtered out — they're covered by the OMITTED block.
    if (omittedPaths.has(file.filename)) continue;

    parts.push("");
    parts.push(
      `### ${file.filename} (${file.status}, +${file.additions} / -${file.deletions})`,
    );
    if (file.previous_filename) {
      parts.push(`Renamed from: ${file.previous_filename}`);
    }
    parts.push("```diff");
    parts.push(file.patch ?? PATCH_PLACEHOLDER);
    parts.push("```");
  }

  return parts.join("\n");
}
