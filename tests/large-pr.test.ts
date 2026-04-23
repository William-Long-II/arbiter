import { describe, expect, test } from "bun:test";
import { pickDeepReviewFiles, shouldTriage } from "../src/review/large-pr.ts";
import type { FileDiff, PrContext } from "../src/github/diff.ts";

function f(path: string, patchLen = 500): FileDiff {
  return {
    path,
    patch: "x".repeat(patchLen),
    rightLines: new Set<number>(),
    leftLines: new Set<number>(),
    status: "modified",
  };
}

function pr(files: FileDiff[]): PrContext {
  return {
    title: "t",
    body: "b",
    base_ref: "main",
    head_ref: "feat",
    head_sha: "abc",
    files,
  };
}

describe("shouldTriage", () => {
  test("below both thresholds → no triage", () => {
    const p = pr([f("a.ts"), f("b.ts")]);
    expect(shouldTriage(p, { fileCount: 25, diffBytes: 100_000, deepReviewFiles: 15 })).toBe(false);
  });

  test("file count threshold trips", () => {
    const files = Array.from({ length: 30 }, (_, i) => f(`f${i}.ts`, 10));
    expect(shouldTriage(pr(files), { fileCount: 25, diffBytes: 1_000_000, deepReviewFiles: 15 })).toBe(true);
  });

  test("byte threshold trips even with few files", () => {
    const files = [f("huge.ts", 200_000)];
    expect(shouldTriage(pr(files), { fileCount: 100, diffBytes: 100_000, deepReviewFiles: 15 })).toBe(true);
  });

  test("byte threshold short-circuits — total over threshold stops counting", () => {
    // This test just proves the branch covers the early-return path; the
    // behavior is equivalent to summing everything.
    const files = [f("a.ts", 60_000), f("b.ts", 60_000), f("c.ts", 500_000)];
    expect(shouldTriage(pr(files), { fileCount: 100, diffBytes: 100_000, deepReviewFiles: 15 })).toBe(true);
  });

  test("exact-at-threshold triggers (>=, not >)", () => {
    const files = Array.from({ length: 25 }, () => f("x.ts", 10));
    expect(shouldTriage(pr(files), { fileCount: 25, diffBytes: 1_000_000, deepReviewFiles: 15 })).toBe(true);
  });
});

describe("pickDeepReviewFiles", () => {
  const allFiles = [
    f("src/auth.ts", 5000),
    f("src/util.ts", 200),
    f("tests/foo.test.ts", 800),
    f("README.md", 100),
    f("fixtures/big.json", 10_000),
  ];

  test("honors priority order: high → medium → low", () => {
    const { kept } = pickDeepReviewFiles({
      triage: [
        { path: "README.md", priority: "low", reason: "docs" },
        { path: "src/auth.ts", priority: "high", reason: "auth" },
        { path: "src/util.ts", priority: "medium", reason: "util" },
      ],
      allFiles,
      limit: 3,
    });
    expect(kept[0]).toBe("src/auth.ts");
    expect(kept[1]).toBe("src/util.ts");
    expect(kept[2]).toBe("README.md");
  });

  test("within a priority tie, larger patch wins", () => {
    const { kept } = pickDeepReviewFiles({
      triage: [
        { path: "src/auth.ts", priority: "high", reason: "big auth file" },
        { path: "fixtures/big.json", priority: "high", reason: "big fixture" },
      ],
      allFiles,
      limit: 2,
    });
    // big.json has patch len 10000 > auth.ts 5000
    expect(kept[0]).toBe("fixtures/big.json");
    expect(kept[1]).toBe("src/auth.ts");
  });

  test("hallucinated paths not in the PR are silently dropped", () => {
    const { kept } = pickDeepReviewFiles({
      triage: [
        { path: "src/auth.ts", priority: "high", reason: "auth" },
        { path: "nonexistent/made-up.ts", priority: "high", reason: "imaginary" },
      ],
      allFiles,
      limit: 10,
    });
    expect(kept).toContain("src/auth.ts");
    expect(kept).not.toContain("nonexistent/made-up.ts");
  });

  test("unclassified files appear after classified ones", () => {
    const { kept, deferred } = pickDeepReviewFiles({
      triage: [{ path: "src/auth.ts", priority: "medium", reason: "meh" }],
      allFiles,
      limit: 3,
    });
    // src/auth.ts was classified → first. remaining appended in their
    // natural allFiles order.
    expect(kept[0]).toBe("src/auth.ts");
    expect(kept).toHaveLength(3);
    // Deferred contains whatever didn't fit.
    expect(kept.length + deferred.length).toBe(allFiles.length);
  });

  test("limit caps kept even when triage returned more", () => {
    const lots = Array.from({ length: 20 }, (_, i) => f(`src/f${i}.ts`));
    const triage = lots.map((file) => ({
      path: file.path,
      priority: "high" as const,
      reason: "x",
    }));
    const { kept, deferred } = pickDeepReviewFiles({ triage, allFiles: lots, limit: 5 });
    expect(kept).toHaveLength(5);
    expect(deferred).toHaveLength(15);
  });

  test("limit of 0 or negative is clamped to 1 (always review at least one)", () => {
    const { kept } = pickDeepReviewFiles({
      triage: [{ path: "src/auth.ts", priority: "high", reason: "auth" }],
      allFiles,
      limit: 0,
    });
    expect(kept).toHaveLength(1);
  });
});
