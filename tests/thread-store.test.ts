import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/state/db.ts";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "auto-reviewer-test-"));
  return {
    path: join(dir, "state.sqlite"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // leave it for the OS temp cleaner
      }
    },
  };
}

describe("review_threads storage", () => {
  test("listReviewThreads returns [] when no rows exist for the PR", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      expect(store.listReviewThreads("a/b", 1)).toEqual([]);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("upsert inserts new rows and updates existing ones by (repo, pr, root_comment_id)", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.upsertReviewThread({
        repo: "a/b",
        pr_number: 42,
        root_comment_id: 100,
        last_responded_to_reply_id: 101,
      });
      store.upsertReviewThread({
        repo: "a/b",
        pr_number: 42,
        root_comment_id: 200,
        last_responded_to_reply_id: 201,
      });
      // Same repo + PR but different PR number should stay separate.
      store.upsertReviewThread({
        repo: "a/b",
        pr_number: 43,
        root_comment_id: 100,
        last_responded_to_reply_id: 999,
      });

      const onPr42 = store.listReviewThreads("a/b", 42).sort(
        (a, b) => a.root_comment_id - b.root_comment_id,
      );
      expect(onPr42).toHaveLength(2);
      expect(onPr42[0]!.root_comment_id).toBe(100);
      expect(onPr42[0]!.last_responded_to_reply_id).toBe(101);
      expect(onPr42[1]!.root_comment_id).toBe(200);

      const onPr43 = store.listReviewThreads("a/b", 43);
      expect(onPr43).toHaveLength(1);
      expect(onPr43[0]!.last_responded_to_reply_id).toBe(999);

      // Upsert bumps watermark on an existing row; does not duplicate.
      store.upsertReviewThread({
        repo: "a/b",
        pr_number: 42,
        root_comment_id: 100,
        last_responded_to_reply_id: 150,
      });
      const updated = store.listReviewThreads("a/b", 42).sort(
        (a, b) => a.root_comment_id - b.root_comment_id,
      );
      expect(updated).toHaveLength(2);
      expect(updated[0]!.last_responded_to_reply_id).toBe(150);

      store.close();
    } finally {
      cleanup();
    }
  });

  test("last_responded_at is populated with an ISO timestamp", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.upsertReviewThread({
        repo: "a/b",
        pr_number: 1,
        root_comment_id: 10,
        last_responded_to_reply_id: 11,
      });
      const rows = store.listReviewThreads("a/b", 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.last_responded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      store.close();
    } finally {
      cleanup();
    }
  });
});
