import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/state/db.ts";

/**
 * backup-db.ts is a thin CLI around SQLite's `VACUUM INTO`. The interesting
 * property to verify is that the snapshot it produces is a complete,
 * consistent copy of the live DB — including WAL writes that hadn't been
 * checkpointed. This test exercises the same sqlite machinery the script
 * uses.
 */
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "auto-reviewer-backup-"));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("VACUUM INTO snapshot (backup-db mechanic)", () => {
  test("produces a readable copy with all committed rows", () => {
    const { dir, cleanup } = tmp();
    try {
      const srcPath = join(dir, "src.sqlite");
      const dstPath = join(dir, "snap.sqlite");

      const src = openStore(srcPath);
      src.recordReview({ repo: "a/b", prNumber: 1, headSha: "s1", verdict: "approve" });
      src.recordReview({ repo: "a/b", prNumber: 2, headSha: "s2", verdict: "request_changes" });
      src.setScalar("github.bot_username", "my-bot");
      src.addWatchedRepo("a/b");

      // Run VACUUM INTO exactly as backup-db.ts does.
      src.db.run(`VACUUM INTO '${dstPath.replace(/'/g, "''")}'`);
      src.close();

      expect(existsSync(dstPath)).toBe(true);
      expect(statSync(dstPath).size).toBeGreaterThan(0);

      // Open the snapshot through the normal store so migrations + prepared
      // statements initialize cleanly — if VACUUM INTO produced a corrupt
      // copy, openStore would blow up here.
      const snap = openStore(dstPath);
      const counts = snap.counts();
      expect(counts.reviews).toBe(2);
      expect(counts.scalars).toBeGreaterThanOrEqual(1);
      expect(counts.repos).toBe(1);
      expect(snap.getScalar("github.bot_username")).toBe("my-bot");
      snap.close();
    } finally {
      cleanup();
    }
  });

  test("snapshot is independent — mutating the source afterward doesn't leak in", () => {
    const { dir, cleanup } = tmp();
    try {
      const srcPath = join(dir, "src.sqlite");
      const dstPath = join(dir, "snap.sqlite");

      const src = openStore(srcPath);
      src.setScalar("review.dry_run", "true");
      src.db.run(`VACUUM INTO '${dstPath.replace(/'/g, "''")}'`);

      // Mutate source AFTER the snapshot — the snapshot must NOT reflect this.
      src.setScalar("review.dry_run", "false");
      src.close();

      const snap = new Database(dstPath);
      const row = snap.prepare("SELECT value FROM config_scalars WHERE key=?").get("review.dry_run") as { value: string };
      snap.close();
      expect(row.value).toBe("true");
    } finally {
      cleanup();
    }
  });

  test("VACUUM INTO refuses to overwrite an existing file (caller must unlink first)", () => {
    // Documents the precondition that backup-db.ts handles with existsSync +
    // unlinkSync. If sqlite's behavior ever changes to overwrite silently,
    // we want this test to tell us.
    const { dir, cleanup } = tmp();
    try {
      const srcPath = join(dir, "src.sqlite");
      const dstPath = join(dir, "snap.sqlite");

      const src = openStore(srcPath);
      src.db.run(`VACUUM INTO '${dstPath.replace(/'/g, "''")}'`);
      // Second call without unlinking first should throw.
      expect(() => src.db.run(`VACUUM INTO '${dstPath.replace(/'/g, "''")}'`)).toThrow();
      src.close();
    } finally {
      cleanup();
    }
  });
});
