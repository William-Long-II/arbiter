import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/state/db.ts";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "auto-reviewer-test-"));
  return {
    path: join(dir, "state.sqlite"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("pr_failures (dead-letter)", () => {
  test("recordFailure returns incrementing count", () => {
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      expect(
        s.recordFailure({ repo: "a/b", prNumber: 1, headSha: "sha1", kind: "claude", error: "x" }),
      ).toBe(1);
      expect(
        s.recordFailure({ repo: "a/b", prNumber: 1, headSha: "sha1", kind: "claude", error: "y" }),
      ).toBe(2);
      expect(
        s.recordFailure({ repo: "a/b", prNumber: 1, headSha: "sha1", kind: "post", error: "z" }),
      ).toBe(3);
      s.close();
    } finally {
      cleanup();
    }
  });

  test("getFailure reflects last_error and last_kind from the most recent bump", () => {
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      s.recordFailure({ repo: "a/b", prNumber: 1, headSha: "sha1", kind: "claude", error: "first" });
      s.recordFailure({ repo: "a/b", prNumber: 1, headSha: "sha1", kind: "post", error: "second" });
      const f = s.getFailure("a/b", 1, "sha1")!;
      expect(f.failure_count).toBe(2);
      expect(f.last_kind).toBe("post");
      expect(f.last_error).toBe("second");
      // first_failed_at stays the same
      expect(f.first_failed_at).toBeDefined();
      s.close();
    } finally {
      cleanup();
    }
  });

  test("clearFailure deletes the row", () => {
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      s.recordFailure({ repo: "a/b", prNumber: 1, headSha: "sha1", kind: "x", error: "x" });
      expect(s.getFailure("a/b", 1, "sha1")).not.toBeNull();
      s.clearFailure("a/b", 1, "sha1");
      expect(s.getFailure("a/b", 1, "sha1")).toBeNull();
      s.close();
    } finally {
      cleanup();
    }
  });

  test("listDeadLettered filters by threshold and excludes dismissed", () => {
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      // Below-threshold
      s.recordFailure({ repo: "a/b", prNumber: 1, headSha: "s1", kind: "claude", error: "e1" });
      s.recordFailure({ repo: "a/b", prNumber: 1, headSha: "s1", kind: "claude", error: "e1" });
      // At threshold
      for (let i = 0; i < 3; i++)
        s.recordFailure({ repo: "a/b", prNumber: 2, headSha: "s2", kind: "claude", error: "e2" });
      // At threshold but dismissed
      for (let i = 0; i < 3; i++)
        s.recordFailure({ repo: "a/b", prNumber: 3, headSha: "s3", kind: "claude", error: "e3" });
      s.dismissFailure("a/b", 3, "s3");

      const dead = s.listDeadLettered(3);
      expect(dead).toHaveLength(1);
      expect(dead[0]!.pr_number).toBe(2);
      s.close();
    } finally {
      cleanup();
    }
  });

  test("dismissFailure sets dismissed_at without changing failure_count", () => {
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      s.recordFailure({ repo: "a/b", prNumber: 1, headSha: "s1", kind: "x", error: "x" });
      s.recordFailure({ repo: "a/b", prNumber: 1, headSha: "s1", kind: "x", error: "x" });
      s.dismissFailure("a/b", 1, "s1");
      const f = s.getFailure("a/b", 1, "s1")!;
      expect(f.failure_count).toBe(2);
      expect(f.dismissed_at).toBeTruthy();
      s.close();
    } finally {
      cleanup();
    }
  });

  test("listDeadLettered orders newest-fail first when timestamps differ", async () => {
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      for (let i = 0; i < 3; i++)
        s.recordFailure({ repo: "a/b", prNumber: 1, headSha: "s1", kind: "x", error: "x" });
      // Sleep past ISO millisecond resolution so the subsequent bump is
      // observably newer — without this sleep, sort stability among rows
      // with identical last_failed_at is undefined.
      await new Promise((r) => setTimeout(r, 5));
      for (let i = 0; i < 3; i++)
        s.recordFailure({ repo: "a/b", prNumber: 2, headSha: "s2", kind: "x", error: "x" });

      const dead = s.listDeadLettered(3);
      expect(dead).toHaveLength(2);
      expect(dead[0]!.pr_number).toBe(2); // most recent
      expect(dead[1]!.pr_number).toBe(1);
      s.close();
    } finally {
      cleanup();
    }
  });
});
