import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/state/db.ts";
import { computeMetrics, invalidateMetricsCache } from "../src/metrics.ts";

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

function seedReview(
  store: ReturnType<typeof openStore>,
  args: {
    repo: string;
    pr: number;
    sha: string;
    verdict: "approve" | "request_changes" | "dry_run" | "skipped";
    valid?: Array<{ severity: "nit" | "suggestion" | "issue" | "blocker" }>;
    dropped?: Array<{ severity: "nit" | "suggestion" | "issue" | "blocker" }>;
  },
) {
  const note = JSON.stringify({
    verdict: args.verdict,
    valid: (args.valid ?? []).map((c) => ({ severity: c.severity, path: "x", line: 1, side: "RIGHT", body: "b" })),
    dropped: (args.dropped ?? []).map((c) => ({ comment: { severity: c.severity, path: "x", line: 1, side: "RIGHT", body: "b" }, reason: "oob" })),
    summary: "s",
  });
  store.recordReview({
    repo: args.repo,
    prNumber: args.pr,
    headSha: args.sha,
    verdict: args.verdict,
    note,
  });
}

describe("computeMetrics", () => {
  test("empty store returns nulls where honest, zeros for pure counts", () => {
    invalidateMetricsCache();
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      const m = computeMetrics(s, "7d");
      expect(m.volume.total).toBe(0);
      expect(m.approvalRate).toBeNull();
      expect(m.avgLatencySeconds).toBeNull();
      expect(m.avgCommentsPerReview).toBeNull();
      expect(m.droppedCommentRate).toBeNull();
      expect(m.avgFilesFilteredOut).toBeNull();
      expect(m.failures).toEqual({
        claude_failed: 0,
        post_failed: 0,
        breaker_deferred: 0,
        dead_letter_entered: 0,
      });
      s.close();
    } finally {
      cleanup();
    }
  });

  test("volume counts verdicts; approval rate ignores dry_run and skipped", () => {
    invalidateMetricsCache();
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      seedReview(s, { repo: "a/b", pr: 1, sha: "s1", verdict: "approve" });
      seedReview(s, { repo: "a/b", pr: 2, sha: "s2", verdict: "approve" });
      seedReview(s, { repo: "a/b", pr: 3, sha: "s3", verdict: "approve" });
      seedReview(s, { repo: "a/b", pr: 4, sha: "s4", verdict: "request_changes" });
      seedReview(s, { repo: "a/b", pr: 5, sha: "s5", verdict: "dry_run" });
      seedReview(s, { repo: "a/b", pr: 6, sha: "s6", verdict: "skipped" });

      const m = computeMetrics(s, "7d");
      expect(m.volume.total).toBe(6);
      expect(m.volume.approve).toBe(3);
      expect(m.volume.request_changes).toBe(1);
      expect(m.volume.dry_run).toBe(1);
      expect(m.volume.skipped).toBe(1);
      expect(m.approvalRate).toBe(0.75); // 3 / (3+1)
      s.close();
    } finally {
      cleanup();
    }
  });

  test("comment severity averages + dropped rate over reviews-with-notes", () => {
    invalidateMetricsCache();
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      seedReview(s, {
        repo: "a/b", pr: 1, sha: "s1", verdict: "approve",
        valid: [
          { severity: "nit" },
          { severity: "nit" },
          { severity: "suggestion" },
        ],
        dropped: [{ severity: "issue" }],
      });
      seedReview(s, {
        repo: "a/b", pr: 2, sha: "s2", verdict: "request_changes",
        valid: [
          { severity: "issue" },
          { severity: "blocker" },
        ],
        dropped: [],
      });

      const m = computeMetrics(s, "7d");
      expect(m.avgCommentsPerReview).toEqual({
        nit: 1, // (2+0)/2
        suggestion: 0.5, // (1+0)/2
        issue: 0.5, // (0+1)/2
        blocker: 0.5, // (0+1)/2
      });
      // total valid = 5, total dropped = 1 → 1/6 ≈ 0.1667
      expect(m.droppedCommentRate).toBeCloseTo(1 / 6, 3);
      s.close();
    } finally {
      cleanup();
    }
  });

  test("avgFilesFilteredOut averages claude.invoke payloads; null if no events", () => {
    invalidateMetricsCache();
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      s.recordEvent({
        level: "info", kind: "claude.invoke", message: "x",
        payload: { filesFilteredOut: 3 },
      });
      s.recordEvent({
        level: "info", kind: "claude.invoke", message: "x",
        payload: { filesFilteredOut: 9 },
      });
      // event without the field should be skipped, not treated as 0
      s.recordEvent({ level: "info", kind: "claude.invoke", message: "x" });
      const m = computeMetrics(s, "7d");
      expect(m.avgFilesFilteredOut).toBe(6); // (3+9)/2
      s.close();
    } finally {
      cleanup();
    }
  });

  test("failure counts by kind", () => {
    invalidateMetricsCache();
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      for (let i = 0; i < 3; i++) s.recordEvent({ level: "error", kind: "claude.failed", message: "x" });
      s.recordEvent({ level: "error", kind: "post.failed", message: "x" });
      s.recordEvent({ level: "warn", kind: "breaker.deferred", message: "x" });
      s.recordEvent({ level: "warn", kind: "dead_letter.entered", message: "x" });
      // unrelated events don't count
      s.recordEvent({ level: "info", kind: "post.ok", message: "x" });
      const m = computeMetrics(s, "7d");
      expect(m.failures).toEqual({
        claude_failed: 3,
        post_failed: 1,
        breaker_deferred: 1,
        dead_letter_entered: 1,
      });
      s.close();
    } finally {
      cleanup();
    }
  });

  test("avgLatency pairs claude.invoke with matching post.ok", () => {
    invalidateMetricsCache();
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      // Inject events with controlled timestamps via direct SQL so we can
      // measure latency deterministically. Two PRs, one 5s, one 15s.
      const insert = s.db.prepare(
        `INSERT INTO events(ts, level, kind, repo, pr_number, head_sha, message)
         VALUES (?, 'info', ?, ?, ?, ?, 'x')`,
      );
      insert.run("2026-04-23T00:00:00.000Z", "claude.invoke", "a/b", 1, "s1");
      insert.run("2026-04-23T00:00:05.000Z", "post.ok", "a/b", 1, "s1");
      insert.run("2026-04-23T00:00:00.000Z", "claude.invoke", "a/b", 2, "s2");
      insert.run("2026-04-23T00:00:15.000Z", "post.ok", "a/b", 2, "s2");
      const m = computeMetrics(s, "30d");
      expect(m.avgLatencySeconds).toBe(10); // (5+15)/2
      s.close();
    } finally {
      cleanup();
    }
  });

  test("window filters out older data", () => {
    invalidateMetricsCache();
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      // One "recent" review (now) and one ancient one (60 days ago).
      seedReview(s, { repo: "a/b", pr: 1, sha: "s1", verdict: "approve" });
      s.db
        .prepare(
          `INSERT INTO reviews(repo, pr_number, head_sha, verdict, note, reviewed_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run("a/b", 99, "s99", "request_changes", "2026-02-23T00:00:00.000Z");

      const m24 = computeMetrics(s, "24h");
      expect(m24.volume.total).toBe(1);
      invalidateMetricsCache();
      const m30 = computeMetrics(s, "30d");
      expect(m30.volume.total).toBe(1);
      invalidateMetricsCache();
      // no 60d window but if we fake it with a future seed... just trust 24h
      // vs 30d is enough to prove the cutoff.
      s.close();
    } finally {
      cleanup();
    }
  });

  test("cache returns same object for back-to-back calls", () => {
    invalidateMetricsCache();
    const { path, cleanup } = tmp();
    try {
      const s = openStore(path);
      seedReview(s, { repo: "a/b", pr: 1, sha: "s1", verdict: "approve" });
      const a = computeMetrics(s, "7d");
      const b = computeMetrics(s, "7d");
      expect(a).toBe(b);
      s.close();
    } finally {
      cleanup();
    }
  });
});
