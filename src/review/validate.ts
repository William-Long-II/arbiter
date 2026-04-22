import type { PrContext } from "../github/diff.ts";
import type { LineComment, ReviewResult } from "../claude/schema.ts";

export type ValidatedReview = {
  valid: LineComment[];
  dropped: { comment: LineComment; reason: string }[];
  summary: string;
  verdict: ReviewResult["verdict"];
};

/**
 * GitHub rejects review comments whose (path, line, side) isn't inside a diff
 * hunk. Validate each comment against the parsed hunks; drop invalid ones and
 * surface them in the summary body so the user still sees the observation.
 */
export function validateReview(review: ReviewResult, pr: PrContext): ValidatedReview {
  const byPath = new Map(pr.files.map((f) => [f.path, f]));
  const valid: LineComment[] = [];
  const dropped: ValidatedReview["dropped"] = [];

  for (const c of review.line_comments) {
    const file = byPath.get(c.path);
    if (!file) {
      dropped.push({ comment: c, reason: `file not in diff: ${c.path}` });
      continue;
    }
    const lines = c.side === "LEFT" ? file.leftLines : file.rightLines;
    if (!lines.has(c.line)) {
      dropped.push({
        comment: c,
        reason: `line ${c.line} (${c.side}) is not inside any hunk for ${c.path}`,
      });
      continue;
    }
    valid.push(c);
  }

  let summary = review.summary.trim();
  if (dropped.length > 0) {
    const notes = dropped
      .map(
        (d) =>
          `- **${d.comment.path}:${d.comment.line}** (${d.comment.severity}): ${d.comment.body}`,
      )
      .join("\n");
    summary += `\n\n---\n_Additional observations that could not be attached to specific diff lines:_\n${notes}`;
  }

  return { valid, dropped, summary, verdict: review.verdict };
}
