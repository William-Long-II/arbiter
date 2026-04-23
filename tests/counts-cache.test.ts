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
      } catch {}
    },
  };
}

describe("counts() cache", () => {
  test("returns same object between reads when nothing changes", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const a = store.counts();
      const b = store.counts();
      // Same reference — cache hit.
      expect(a).toBe(b);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("invalidates after a write", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const before = store.counts();
      expect(before.scalars).toBe(0);
      store.setScalar("x", "1");
      const after = store.counts();
      expect(after).not.toBe(before); // fresh object
      expect(after.scalars).toBe(1);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("every mutator bumps the version", () => {
    // Sanity test: walk through each mutator and assert the corresponding
    // count goes up. Protects against someone adding a new mutator and
    // forgetting to call bump().
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      expect(store.counts().reviews).toBe(0);
      store.recordReview({ repo: "a/b", prNumber: 1, headSha: "s1", verdict: "dry_run" });
      expect(store.counts().reviews).toBe(1);

      expect(store.counts().events).toBe(0);
      store.recordEvent({ level: "info", kind: "k", message: "m" });
      expect(store.counts().events).toBe(1);

      expect(store.counts().orgs).toBe(0);
      store.upsertOrg({
        name: "org-a",
        mode: "all",
        include_json: "[]",
        exclude_json: "[]",
        tone_override: null,
        tone_mode: "append",
      });
      expect(store.counts().orgs).toBe(1);

      expect(store.counts().repos).toBe(0);
      store.addWatchedRepo("a/b");
      expect(store.counts().repos).toBe(1);

      expect(store.counts().skip_authors).toBe(0);
      store.addSkipAuthor("alice");
      expect(store.counts().skip_authors).toBe(1);

      // Removals invalidate too.
      store.removeSkipAuthor("alice");
      expect(store.counts().skip_authors).toBe(0);
      store.removeWatchedRepo("a/b");
      expect(store.counts().repos).toBe(0);
      store.deleteOrg("org-a");
      expect(store.counts().orgs).toBe(0);

      store.close();
    } finally {
      cleanup();
    }
  });

  test("clearDedupe without changes does NOT force a cache miss", () => {
    // clearDedupe returns the number of deleted rows — for a PR with no
    // dedupe entries it returns 0 and should not bump the version.
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const a = store.counts();
      store.clearDedupe("never/seen", 999);
      const b = store.counts();
      expect(a).toBe(b);
      store.close();
    } finally {
      cleanup();
    }
  });
});
