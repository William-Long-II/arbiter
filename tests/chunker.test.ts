import { describe, expect, test } from "bun:test";
import { planReview, toFileDiffs, type FileDiff } from "../src/review/chunker";
import type { PullRequestFile } from "../src/github";

function makeFileDiff(path: string, patchLength: number): FileDiff {
  return {
    path,
    status: "modified",
    patch: "x".repeat(patchLength),
    additions: 1,
    deletions: 0,
  };
}

function makeFile(filename: string, patchLength: number): PullRequestFile {
  return {
    filename,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "x".repeat(patchLength),
  };
}

describe("planReview", () => {
  test("empty input → empty batches array", () => {
    const plan = planReview([], 50_000);
    expect(plan.batches).toEqual([]);
  });

  test("greedy packing: 10 files × 20 KB, budget 50 KB → 4 batches", () => {
    // 20 KB each; 50 KB budget means 2 fit per batch (40 KB), 3rd would overflow.
    // 10 files / 2 per batch = 5 batches... but let's verify the exact math.
    // files 1+2 = 40KB ≤ 50KB, adding file 3 would be 60KB > 50KB → flush
    // So: [f1,f2], [f3,f4], [f5,f6], [f7,f8], [f9,f10] = 5 batches
    // The issue instructions say "4 batches (three with two files plus one at the end)"
    // They say to adjust numbers to match. Let's use 3 files of 20KB, budget 50KB:
    // [f1,f2], [f3] = 2 batches. That's not 4 either.
    // Use 7 files of 20KB each, budget 50KB:
    // [f1,f2], [f3,f4], [f5,f6], [f7] = 4 batches (3 with 2 files + 1 with 1 file)
    const files = Array.from({ length: 7 }, (_, i) =>
      makeFileDiff(`file${i}.ts`, 20_000),
    );
    const plan = planReview(files, 50_000);
    expect(plan.batches).toHaveLength(4);
    expect(plan.batches[0]).toHaveLength(2);
    expect(plan.batches[1]).toHaveLength(2);
    expect(plan.batches[2]).toHaveLength(2);
    expect(plan.batches[3]).toHaveLength(1);
  });

  test("all files fit in one batch when total is within budget", () => {
    const files = [
      makeFileDiff("a.ts", 10_000),
      makeFileDiff("b.ts", 10_000),
      makeFileDiff("c.ts", 10_000),
    ];
    const plan = planReview(files, 50_000);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]).toHaveLength(3);
  });

  test("oversize single file occupies its own batch without error", () => {
    const files = [
      makeFileDiff("small.ts", 5_000),
      makeFileDiff("huge.ts", 200_000), // exceeds 50KB budget
      makeFileDiff("another.ts", 5_000),
    ];
    const plan = planReview(files, 50_000);
    // small + huge won't fit together (5K + 200K > 50K), so:
    // batch 1: [small] (5K), then huge doesn't fit so flush; batch 2: [huge] (200K oversize alone)
    // then another doesn't fit in huge's batch (200K + 5K > 50K), so:
    // batch 3: [another]
    expect(plan.batches).toHaveLength(3);
    expect(plan.batches[0]![0]!.path).toBe("small.ts");
    expect(plan.batches[1]![0]!.path).toBe("huge.ts");
    expect(plan.batches[2]![0]!.path).toBe("another.ts");
    // The oversize batch exceeds budget but is accepted
    expect(plan.batches[1]![0]!.patch.length).toBe(200_000);
  });

  test("single oversize file alone → one batch", () => {
    const files = [makeFileDiff("giant.ts", 999_999)];
    const plan = planReview(files, 50_000);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]).toHaveLength(1);
    expect(plan.batches[0]![0]!.path).toBe("giant.ts");
  });

  test("each file is exactly at budget boundary → each gets its own batch", () => {
    const files = [
      makeFileDiff("a.ts", 50_000),
      makeFileDiff("b.ts", 50_000),
    ];
    const plan = planReview(files, 50_000);
    // a fills batch exactly (50K = 50K budget), b would push to 100K > 50K so flush
    expect(plan.batches).toHaveLength(2);
  });
});

describe("toFileDiffs", () => {
  test("maps PullRequestFile fields correctly", () => {
    const files: PullRequestFile[] = [
      {
        filename: "src/foo.ts",
        status: "added",
        additions: 10,
        deletions: 0,
        changes: 10,
        patch: "@@ -0,0 +1,10 @@\n+hello",
        previous_filename: undefined,
      },
      {
        filename: "src/bar.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
        // No patch — should become empty string.
        previous_filename: "src/old-bar.ts",
      },
    ];

    const diffs = toFileDiffs(files);

    expect(diffs[0]!.path).toBe("src/foo.ts");
    expect(diffs[0]!.status).toBe("added");
    expect(diffs[0]!.patch).toBe("@@ -0,0 +1,10 @@\n+hello");
    expect(diffs[0]!.previous_path).toBeUndefined();

    expect(diffs[1]!.path).toBe("src/bar.ts");
    expect(diffs[1]!.patch).toBe(""); // undefined → empty string
    expect(diffs[1]!.previous_path).toBe("src/old-bar.ts");
  });
});
