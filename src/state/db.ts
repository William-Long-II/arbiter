import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type Verdict = "approve" | "request_changes" | "dry_run" | "skipped";

export type Store = {
  db: Database;
  recordReview(args: {
    repo: string;
    prNumber: number;
    headSha: string;
    verdict: Verdict;
    note?: string;
  }): void;
  hasReviewed(repo: string, prNumber: number, headSha: string): boolean;
  approvalsInLastHour(): number;
  close(): void;
};

export function openStore(path: string): Store {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      verdict TEXT NOT NULL,
      note TEXT,
      reviewed_at TEXT NOT NULL,
      PRIMARY KEY (repo, pr_number, head_sha)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reviews_time ON reviews(reviewed_at);`);

  const insert = db.prepare(
    `INSERT OR REPLACE INTO reviews(repo, pr_number, head_sha, verdict, note, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const selectOne = db.prepare(
    `SELECT 1 AS hit FROM reviews WHERE repo = ? AND pr_number = ? AND head_sha = ? LIMIT 1`,
  );
  const countApprovals = db.prepare(
    `SELECT COUNT(*) AS n FROM reviews WHERE verdict = 'approve' AND reviewed_at >= ?`,
  );

  return {
    db,
    recordReview({ repo, prNumber, headSha, verdict, note }) {
      insert.run(repo, prNumber, headSha, verdict, note ?? null, new Date().toISOString());
    },
    hasReviewed(repo, prNumber, headSha) {
      const row = selectOne.get(repo, prNumber, headSha) as { hit: number } | undefined;
      return !!row;
    },
    approvalsInLastHour() {
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const row = countApprovals.get(since) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    close() {
      db.close();
    },
  };
}
