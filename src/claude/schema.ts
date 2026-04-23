import { z } from "zod";

export const Severity = z.enum(["nit", "suggestion", "issue", "blocker"]);

export const LineComment = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: z.enum(["RIGHT", "LEFT"]).default("RIGHT"),
  body: z.string().min(1),
  severity: Severity,
});

export const ReviewResult = z
  .object({
    summary: z.string().min(1),
    line_comments: z.array(LineComment).default([]),
    verdict: z.enum(["approve", "request_changes"]),
  })
  .refine(
    (r) => {
      const hasBlocking = r.line_comments.some(
        (c) => c.severity === "blocker" || c.severity === "issue",
      );
      return !(hasBlocking && r.verdict === "approve");
    },
    { message: "verdict must be 'request_changes' when any comment is blocker/issue" },
  );

export type ReviewResult = z.infer<typeof ReviewResult>;
export type LineComment = z.infer<typeof LineComment>;

/**
 * Triage schema — first-pass classification on large PRs. Claude decides
 * which files warrant deep review; the loop then only sends those files'
 * diffs to the review prompt. Priority is the sort key; reason is a
 * one-liner the operator will see on the detail page.
 */
export const TriagePriority = z.enum(["high", "medium", "low"]);

export const TriageEntry = z.object({
  path: z.string().min(1),
  priority: TriagePriority,
  reason: z.string().min(1).max(300),
});

export const TriageResult = z.object({
  priorities: z.array(TriageEntry).default([]),
});

export type TriagePriority = z.infer<typeof TriagePriority>;
export type TriageEntry = z.infer<typeof TriageEntry>;
export type TriageResult = z.infer<typeof TriageResult>;
