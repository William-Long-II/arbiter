import { z } from "zod";

export const LineCommentSchema = z.object({
  path: z
    .string()
    .describe("Repository-relative file path, as it appears in the diff."),
  line: z
    .number()
    .int()
    .positive()
    .describe(
      "Line number in the new file (RIGHT side of the diff). Must reference a line present in the patch.",
    ),
  body: z
    .string()
    .describe(
      "The inline comment. Be constructive and specific. Lead with what to do, not only what is wrong.",
    ),
});

export type LineComment = z.infer<typeof LineCommentSchema>;

export const ReviewResultSchema = z.object({
  verdict: z
    .enum(["approve", "comment"])
    .describe(
      "approve when the PR is ready to merge as-is; comment when the author has actionable feedback to consider. Never block — this is guidance, not gatekeeping.",
    ),
  summary: z
    .string()
    .describe(
      "Markdown summary covering intent alignment, overall quality, and any top-level concerns. Lead with what works; frame issues as paths forward.",
    ),
  lineComments: z
    .array(LineCommentSchema)
    .describe(
      "Zero or more inline comments anchored to specific lines. Skip if nothing specific to call out.",
    ),
});

export type ReviewResult = z.infer<typeof ReviewResultSchema>;
