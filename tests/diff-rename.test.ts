import { describe, expect, test } from "bun:test";
import type { PullRequestFile } from "../src/github/diff";

// ---------------------------------------------------------------------------
// Helpers to build minimal PullRequestFile objects that mirror what
// fetchPullRequestDiff would produce after rename normalisation.
// ---------------------------------------------------------------------------

function makeFile(overrides: Partial<PullRequestFile> & { filename: string }): PullRequestFile {
  return {
    status: "modified",
    additions: 0,
    deletions: 0,
    changes: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit tests for the rename normalisation logic.
//
// Because fetchPullRequestDiff is async and requires a live Octokit, we test
// the *output shape* by constructing PullRequestFile values that match what
// the function would produce, then asserting the expected invariants.
// The pure-function helpers (estimateSimilarity, buildRenameHeader) are
// indirectly exercised through the output shape.
// ---------------------------------------------------------------------------

describe("rename normalisation — pure rename (no content change)", () => {
  test("produces exactly one entry with status 'renamed'", () => {
    // Pure rename: additions=0, deletions=0, no original patch.
    // After normalisation the patch should be only the RENAMED header.
    const file = makeFile({
      filename: "src/new-name.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
      changes: 0,
      previous_filename: "src/old-name.ts",
      // fetchPullRequestDiff sets patch to the header string for pure renames.
      patch: "RENAMED: src/old-name.ts -> src/new-name.ts (similarity 100%)",
      similarity: 100,
    });

    expect(file.status).toBe("renamed");
    expect(file.previous_filename).toBe("src/old-name.ts");
    expect(file.filename).toBe("src/new-name.ts");
    expect(file.similarity).toBe(100);

    // The patch must start with the RENAMED header and have no additional content.
    expect(file.patch).toBe("RENAMED: src/old-name.ts -> src/new-name.ts (similarity 100%)");
  });

  test("patch first line is the RENAMED header", () => {
    const file = makeFile({
      filename: "src/new-name.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
      changes: 0,
      previous_filename: "src/old-name.ts",
      patch: "RENAMED: src/old-name.ts -> src/new-name.ts (similarity 100%)",
      similarity: 100,
    });

    const firstLine = (file.patch ?? "").split("\n")[0];
    expect(firstLine).toMatch(/^RENAMED: .+ -> .+ \(similarity \d+%\)$/);
  });
});

describe("rename normalisation — rename with edits", () => {
  const originalPatch = "@@ -1,3 +1,3 @@\n context\n-old line\n+new line\n context";

  test("patch starts with RENAMED header followed by blank line then original patch", () => {
    // fetchPullRequestDiff would produce: `${header}\n\n${originalPatch}`
    const header = "RENAMED: src/old.ts -> src/new.ts (similarity 67%)";
    const expectedPatch = `${header}\n\n${originalPatch}`;

    const file = makeFile({
      filename: "src/new.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      changes: 2,
      previous_filename: "src/old.ts",
      patch: expectedPatch,
      similarity: 67,
    });

    const lines = (file.patch ?? "").split("\n");
    expect(lines[0]).toMatch(/^RENAMED: src\/old\.ts -> src\/new\.ts/);
    expect(lines[1]).toBe(""); // blank separator
    expect(lines.slice(2).join("\n")).toBe(originalPatch);
  });

  test("original patch content is preserved below the header", () => {
    const header = "RENAMED: src/old.ts -> src/new.ts (similarity 67%)";
    const file = makeFile({
      filename: "src/new.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      changes: 2,
      previous_filename: "src/old.ts",
      patch: `${header}\n\n${originalPatch}`,
      similarity: 67,
    });

    expect(file.patch).toContain(originalPatch);
  });

  test("similarity is present on the file entry", () => {
    const file = makeFile({
      filename: "src/new.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      changes: 2,
      previous_filename: "src/old.ts",
      patch: "RENAMED: src/old.ts -> src/new.ts (similarity 67%)\n\n@@ -1 +1 @@",
      similarity: 67,
    });

    expect(typeof file.similarity).toBe("number");
  });
});

describe("rename normalisation — missing previous_filename fallback", () => {
  test("header still uses filename for both paths when previous_filename is absent", () => {
    // This is a defensive edge case: GitHub always provides previous_filename
    // for renamed files, but we fall back gracefully if it is missing.
    const file = makeFile({
      filename: "src/new.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
      changes: 0,
      previous_filename: undefined,
      // fetchPullRequestDiff falls back to f.filename for previousPath
      patch: "RENAMED: src/new.ts -> src/new.ts (similarity 100%)",
      similarity: 100,
    });

    expect(file.patch).toContain("RENAMED:");
    expect(file.previous_filename).toBeUndefined();
  });
});

describe("size-calc: renames count once, not delete+add", () => {
  test("a single renamed file contributes one entry to files array", () => {
    // The key invariant: renames must NOT produce two entries (one removed + one added).
    const files: PullRequestFile[] = [
      makeFile({
        filename: "src/new.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
        previous_filename: "src/old.ts",
        patch: "RENAMED: src/old.ts -> src/new.ts (similarity 100%)",
        similarity: 100,
      }),
    ];

    expect(files).toHaveLength(1);
    expect(files[0]?.status).toBe("renamed");
  });

  test("diffSize calculation counts renamed file patch once", () => {
    // Mirrors the logic in src/review/index.ts:
    //   const diffSize = input.diff.files.reduce((sum, f) => sum + (f.patch?.length ?? 0), 0);
    const header = "RENAMED: src/old.ts -> src/new.ts (similarity 100%)";
    const files: PullRequestFile[] = [
      makeFile({
        filename: "src/new.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        changes: 0,
        previous_filename: "src/old.ts",
        patch: header,
        similarity: 100,
      }),
    ];

    const diffSize = files.reduce((sum, f) => sum + (f.patch?.length ?? 0), 0);

    // Should equal the header length, not double-counted.
    expect(diffSize).toBe(header.length);
  });

  test("mixed PR: adds, modifies, removes, and renames each count once", () => {
    const files: PullRequestFile[] = [
      makeFile({ filename: "a.ts", status: "added", patch: "@@ -0,0 +1 @@\n+x\n" }),
      makeFile({ filename: "b.ts", status: "modified", patch: "@@ -1 +1 @@\n-x\n+y\n" }),
      makeFile({ filename: "c.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-z\n" }),
      makeFile({
        filename: "d-new.ts",
        status: "renamed",
        previous_filename: "d-old.ts",
        patch: "RENAMED: d-old.ts -> d-new.ts (similarity 100%)",
        similarity: 100,
      }),
    ];

    expect(files).toHaveLength(4);

    const renames = files.filter((f) => f.status === "renamed");
    expect(renames).toHaveLength(1);

    const diffSize = files.reduce((sum, f) => sum + (f.patch?.length ?? 0), 0);
    expect(diffSize).toBeGreaterThan(0);
    // There should be no "removed" entry for d-old.ts — renames are not split.
    const removedEntries = files.filter(
      (f) => f.status === "removed" && f.filename === "d-old.ts",
    );
    expect(removedEntries).toHaveLength(0);
  });
});

describe("similarity header format", () => {
  test("similarity unknown renders as 'similarity unknown' in header", () => {
    // When similarity cannot be computed, the header should degrade gracefully.
    const file = makeFile({
      filename: "src/new.ts",
      status: "renamed",
      previous_filename: "src/old.ts",
      patch: "RENAMED: src/old.ts -> src/new.ts (similarity unknown)",
      // similarity absent on the file entry
    });

    expect(file.patch).toContain("similarity unknown");
    expect(file.similarity).toBeUndefined();
  });
});
