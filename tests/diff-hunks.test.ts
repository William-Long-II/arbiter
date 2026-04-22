import { describe, expect, test } from "bun:test";
import { parseHunks } from "../src/github/diff.ts";

describe("parseHunks", () => {
  test("single hunk with additions and context", () => {
    const patch = [
      "@@ -10,3 +10,4 @@ function foo()",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 20;",
      "+const c = 3;",
      " return a + b;",
    ].join("\n");
    const { rightLines, leftLines } = parseHunks(patch);
    expect([...rightLines].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
    expect([...leftLines].sort((a, b) => a - b)).toEqual([10, 11, 12]);
  });

  test("multiple hunks accumulate independently", () => {
    const patch = [
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " same",
      "@@ -50,1 +60,2 @@",
      " unchanged",
      "+added",
    ].join("\n");
    const { rightLines, leftLines } = parseHunks(patch);
    expect(rightLines.has(1)).toBe(true);
    expect(rightLines.has(2)).toBe(true);
    expect(rightLines.has(60)).toBe(true);
    expect(rightLines.has(61)).toBe(true);
    expect(leftLines.has(1)).toBe(true);
    expect(leftLines.has(2)).toBe(true);
    expect(leftLines.has(50)).toBe(true);
  });

  test("no-newline marker is ignored", () => {
    const patch = [
      "@@ -1,1 +1,1 @@",
      "-foo",
      "+bar",
      "\\ No newline at end of file",
    ].join("\n");
    const { rightLines, leftLines } = parseHunks(patch);
    expect(rightLines.has(1)).toBe(true);
    expect(leftLines.has(1)).toBe(true);
  });

  test("empty patch returns empty sets", () => {
    const { rightLines, leftLines } = parseHunks("");
    expect(rightLines.size).toBe(0);
    expect(leftLines.size).toBe(0);
  });

  test("hunk counts default to 1 when omitted", () => {
    const patch = ["@@ -5 +5 @@", "-x", "+y"].join("\n");
    const { rightLines, leftLines } = parseHunks(patch);
    expect(rightLines.has(5)).toBe(true);
    expect(leftLines.has(5)).toBe(true);
  });
});
