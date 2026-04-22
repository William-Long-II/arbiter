import { describe, expect, test } from "bun:test";
import { validateReview } from "../src/review/validate.ts";
import type { PrContext } from "../src/github/diff.ts";
import type { ReviewResult } from "../src/claude/schema.ts";

function makePr(): PrContext {
  return {
    title: "t",
    body: "b",
    base_ref: "main",
    head_ref: "feat",
    head_sha: "abc",
    files: [
      {
        path: "src/foo.ts",
        patch: "",
        rightLines: new Set([10, 11, 12]),
        leftLines: new Set([5, 6]),
        status: "modified",
      },
    ],
  };
}

describe("validateReview", () => {
  test("keeps comments on valid diff lines", () => {
    const review: ReviewResult = {
      summary: "Looks fine.",
      verdict: "approve",
      line_comments: [
        { path: "src/foo.ts", line: 11, side: "RIGHT", body: "good", severity: "nit" },
      ],
    };
    const out = validateReview(review, makePr());
    expect(out.valid).toHaveLength(1);
    expect(out.dropped).toHaveLength(0);
  });

  test("drops comments on lines outside any hunk, folds into summary", () => {
    const review: ReviewResult = {
      summary: "overview",
      verdict: "request_changes",
      line_comments: [
        { path: "src/foo.ts", line: 11, side: "RIGHT", body: "in hunk", severity: "issue" },
        { path: "src/foo.ts", line: 99, side: "RIGHT", body: "out of hunk", severity: "issue" },
        { path: "other.ts", line: 1, side: "RIGHT", body: "unknown file", severity: "nit" },
      ],
    };
    const out = validateReview(review, makePr());
    expect(out.valid).toHaveLength(1);
    expect(out.dropped).toHaveLength(2);
    expect(out.summary).toContain("Additional observations");
    expect(out.summary).toContain("out of hunk");
    expect(out.summary).toContain("unknown file");
  });

  test("LEFT side uses leftLines set", () => {
    const review: ReviewResult = {
      summary: "x",
      verdict: "request_changes",
      line_comments: [
        { path: "src/foo.ts", line: 5, side: "LEFT", body: "deleted line", severity: "issue" },
        { path: "src/foo.ts", line: 10, side: "LEFT", body: "not in left", severity: "issue" },
      ],
    };
    const out = validateReview(review, makePr());
    expect(out.valid).toHaveLength(1);
    expect(out.valid[0]!.line).toBe(5);
    expect(out.dropped).toHaveLength(1);
  });
});
