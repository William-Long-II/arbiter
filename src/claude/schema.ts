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
