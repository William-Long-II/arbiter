import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type Verdict = "approve" | "request_changes" | "dry_run" | "skipped";

export type ReviewRow = {
  repo: string;
  pr_number: number;
  head_sha: string;
  verdict: Verdict;
  note: string | null;
  reviewed_at: string;
};

export type EventRow = {
  id: number;
  ts: string;
  level: "info" | "warn" | "error";
  kind: string;
  repo: string | null;
  pr_number: number | null;
  head_sha: string | null;
  message: string;
  payload: string | null;
};

export type ToneMode = "append" | "replace";

export type OrgRow = {
  name: string;
  mode: "all" | "include";
  include_json: string; // JSON array of strings
  exclude_json: string; // JSON array of strings
  tone_override: string | null;
  tone_mode: ToneMode;
};

export type RepoRow = {
  slug: string;
  tone_override: string | null;
  tone_mode: ToneMode;
};

export type Store = {
  db: Database;

  // reviews
  recordReview(args: {
    repo: string;
    prNumber: number;
    headSha: string;
    verdict: Verdict;
    note?: string;
  }): void;
  hasReviewed(repo: string, prNumber: number, headSha: string): boolean;
  approvalsInLastHour(): number;
  recentReviews(limit: number): ReviewRow[];
  getReview(repo: string, prNumber: number): ReviewRow | null;
  /**
   * Delete dedupe rows for a PR. If `headSha` is provided, only that row is
   * removed — prior SHA history stays — and the next tick will re-review that
   * specific commit. If omitted, every row for the PR is deleted.
   */
  clearDedupe(repo: string, prNumber: number, headSha?: string): number;

  // events
  recordEvent(args: {
    level: EventRow["level"];
    kind: string;
    message: string;
    repo?: string;
    prNumber?: number;
    headSha?: string;
    payload?: Record<string, unknown>;
  }): void;
  recentEvents(limit: number): EventRow[];
  pruneEvents(olderThanDays: number): number;

  // config scalars (dotted keys like "review.dry_run", "poll.interval_seconds")
  getScalar(key: string): string | null;
  setScalar(key: string, value: string): void;
  allScalars(): Record<string, string>;

  // watch.orgs
  listOrgs(): OrgRow[];
  getOrg(name: string): OrgRow | null;
  upsertOrg(row: OrgRow): void;
  deleteOrg(name: string): void;

  // watch.repos
  listWatchedRepos(): string[];
  listWatchedRepoRows(): RepoRow[];
  getRepo(slug: string): RepoRow | null;
  addWatchedRepo(slug: string): void;
  setRepoTone(slug: string, tone: string | null, mode: ToneMode): void;
  removeWatchedRepo(slug: string): void;

  // github.skip_authors
  listSkipAuthors(): string[];
  addSkipAuthor(username: string): void;
  removeSkipAuthor(username: string): void;

  close(): void;
};

function migrateAddColumn(
  db: Database,
  table: string,
  column: string,
  typeDecl: string,
): void {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDecl}`);
}

export function openStore(path: string): Store {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");

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
    CREATE INDEX IF NOT EXISTS idx_reviews_time ON reviews(reviewed_at);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      kind TEXT NOT NULL,
      repo TEXT,
      pr_number INTEGER,
      head_sha TEXT,
      message TEXT NOT NULL,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);

    CREATE TABLE IF NOT EXISTS config_scalars (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config_watch_orgs (
      name TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK(mode IN ('all','include')),
      include_json TEXT NOT NULL DEFAULT '[]',
      exclude_json TEXT NOT NULL DEFAULT '[]',
      tone_override TEXT,
      tone_mode TEXT NOT NULL DEFAULT 'append' CHECK(tone_mode IN ('append','replace'))
    );

    CREATE TABLE IF NOT EXISTS config_watch_repos (
      slug TEXT PRIMARY KEY,
      tone_override TEXT,
      tone_mode TEXT NOT NULL DEFAULT 'append' CHECK(tone_mode IN ('append','replace'))
    );

    CREATE TABLE IF NOT EXISTS config_skip_authors (
      username TEXT PRIMARY KEY
    );
  `);

  // Migration for DBs created before per-repo tones: add the tone columns if
  // they don't already exist. sqlite can't IF NOT EXISTS a column, so probe
  // and tolerate the duplicate-column error.
  migrateAddColumn(db, "config_watch_orgs", "tone_override", "TEXT");
  migrateAddColumn(
    db,
    "config_watch_orgs",
    "tone_mode",
    "TEXT NOT NULL DEFAULT 'append'",
  );
  migrateAddColumn(db, "config_watch_repos", "tone_override", "TEXT");
  migrateAddColumn(
    db,
    "config_watch_repos",
    "tone_mode",
    "TEXT NOT NULL DEFAULT 'append'",
  );

  // Prepared statements
  const stmts = {
    insertReview: db.prepare(
      `INSERT OR REPLACE INTO reviews(repo, pr_number, head_sha, verdict, note, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    reviewHit: db.prepare(
      `SELECT 1 AS hit FROM reviews WHERE repo=? AND pr_number=? AND head_sha=? LIMIT 1`,
    ),
    approvalCount: db.prepare(
      `SELECT COUNT(*) AS n FROM reviews WHERE verdict='approve' AND reviewed_at >= ?`,
    ),
    recentReviews: db.prepare(
      `SELECT repo, pr_number, head_sha, verdict, note, reviewed_at
       FROM reviews ORDER BY reviewed_at DESC LIMIT ?`,
    ),
    getReview: db.prepare(
      `SELECT repo, pr_number, head_sha, verdict, note, reviewed_at
       FROM reviews WHERE repo=? AND pr_number=?
       ORDER BY reviewed_at DESC LIMIT 1`,
    ),
    clearDedupeAll: db.prepare(`DELETE FROM reviews WHERE repo=? AND pr_number=?`),
    clearDedupeSha: db.prepare(
      `DELETE FROM reviews WHERE repo=? AND pr_number=? AND head_sha=?`,
    ),

    insertEvent: db.prepare(
      `INSERT INTO events(ts, level, kind, repo, pr_number, head_sha, message, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    recentEvents: db.prepare(
      `SELECT id, ts, level, kind, repo, pr_number, head_sha, message, payload
       FROM events ORDER BY id DESC LIMIT ?`,
    ),
    pruneEvents: db.prepare(`DELETE FROM events WHERE ts < ?`),

    getScalar: db.prepare(`SELECT value FROM config_scalars WHERE key=?`),
    setScalar: db.prepare(
      `INSERT INTO config_scalars(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ),
    allScalars: db.prepare(`SELECT key, value FROM config_scalars`),

    listOrgs: db.prepare(
      `SELECT name, mode, include_json, exclude_json, tone_override, tone_mode
       FROM config_watch_orgs ORDER BY name`,
    ),
    getOrg: db.prepare(
      `SELECT name, mode, include_json, exclude_json, tone_override, tone_mode
       FROM config_watch_orgs WHERE name = ?`,
    ),
    upsertOrg: db.prepare(
      `INSERT INTO config_watch_orgs(name, mode, include_json, exclude_json, tone_override, tone_mode)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         mode=excluded.mode,
         include_json=excluded.include_json,
         exclude_json=excluded.exclude_json,
         tone_override=excluded.tone_override,
         tone_mode=excluded.tone_mode`,
    ),
    deleteOrg: db.prepare(`DELETE FROM config_watch_orgs WHERE name=?`),

    listWatchedRepos: db.prepare(`SELECT slug FROM config_watch_repos ORDER BY slug`),
    listWatchedRepoRows: db.prepare(
      `SELECT slug, tone_override, tone_mode FROM config_watch_repos ORDER BY slug`,
    ),
    getRepoRow: db.prepare(
      `SELECT slug, tone_override, tone_mode FROM config_watch_repos WHERE slug=?`,
    ),
    addRepo: db.prepare(
      `INSERT OR IGNORE INTO config_watch_repos(slug, tone_override, tone_mode)
       VALUES (?, NULL, 'append')`,
    ),
    setRepoTone: db.prepare(
      `UPDATE config_watch_repos SET tone_override=?, tone_mode=? WHERE slug=?`,
    ),
    removeRepo: db.prepare(`DELETE FROM config_watch_repos WHERE slug=?`),

    listSkipAuthors: db.prepare(
      `SELECT username FROM config_skip_authors ORDER BY username`,
    ),
    addSkipAuthor: db.prepare(
      `INSERT OR IGNORE INTO config_skip_authors(username) VALUES (?)`,
    ),
    removeSkipAuthor: db.prepare(`DELETE FROM config_skip_authors WHERE username=?`),
  };

  return {
    db,

    recordReview({ repo, prNumber, headSha, verdict, note }) {
      stmts.insertReview.run(
        repo,
        prNumber,
        headSha,
        verdict,
        note ?? null,
        new Date().toISOString(),
      );
    },
    hasReviewed(repo, prNumber, headSha) {
      const row = stmts.reviewHit.get(repo, prNumber, headSha) as
        | { hit: number }
        | undefined;
      return !!row;
    },
    approvalsInLastHour() {
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const row = stmts.approvalCount.get(since) as { n: number } | undefined;
      return row?.n ?? 0;
    },
    recentReviews(limit) {
      return stmts.recentReviews.all(limit) as ReviewRow[];
    },
    getReview(repo, prNumber) {
      const row = stmts.getReview.get(repo, prNumber) as ReviewRow | undefined;
      return row ?? null;
    },
    clearDedupe(repo, prNumber, headSha) {
      const res = headSha
        ? stmts.clearDedupeSha.run(repo, prNumber, headSha)
        : stmts.clearDedupeAll.run(repo, prNumber);
      return Number(res.changes);
    },

    recordEvent({ level, kind, message, repo, prNumber, headSha, payload }) {
      stmts.insertEvent.run(
        new Date().toISOString(),
        level,
        kind,
        repo ?? null,
        prNumber ?? null,
        headSha ?? null,
        message,
        payload ? JSON.stringify(payload) : null,
      );
    },
    recentEvents(limit) {
      return stmts.recentEvents.all(limit) as EventRow[];
    },
    pruneEvents(olderThanDays) {
      if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) return 0;
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
      const res = stmts.pruneEvents.run(cutoff);
      return Number(res.changes);
    },

    getScalar(key) {
      const row = stmts.getScalar.get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    setScalar(key, value) {
      stmts.setScalar.run(key, value);
    },
    allScalars() {
      const rows = stmts.allScalars.all() as { key: string; value: string }[];
      const out: Record<string, string> = {};
      for (const r of rows) out[r.key] = r.value;
      return out;
    },

    listOrgs() {
      return stmts.listOrgs.all() as OrgRow[];
    },
    getOrg(name) {
      const row = stmts.getOrg.get(name) as OrgRow | undefined;
      return row ?? null;
    },
    upsertOrg(row) {
      stmts.upsertOrg.run(
        row.name,
        row.mode,
        row.include_json,
        row.exclude_json,
        row.tone_override,
        row.tone_mode,
      );
    },
    deleteOrg(name) {
      stmts.deleteOrg.run(name);
    },

    listWatchedRepos() {
      const rows = stmts.listWatchedRepos.all() as { slug: string }[];
      return rows.map((r) => r.slug);
    },
    listWatchedRepoRows() {
      return stmts.listWatchedRepoRows.all() as RepoRow[];
    },
    getRepo(slug) {
      const row = stmts.getRepoRow.get(slug) as RepoRow | undefined;
      return row ?? null;
    },
    addWatchedRepo(slug) {
      stmts.addRepo.run(slug);
    },
    setRepoTone(slug, tone, mode) {
      stmts.setRepoTone.run(tone, mode, slug);
    },
    removeWatchedRepo(slug) {
      stmts.removeRepo.run(slug);
    },

    listSkipAuthors() {
      const rows = stmts.listSkipAuthors.all() as { username: string }[];
      return rows.map((r) => r.username);
    },
    addSkipAuthor(username) {
      stmts.addSkipAuthor.run(username);
    },
    removeSkipAuthor(username) {
      stmts.removeSkipAuthor.run(username);
    },

    close() {
      db.close();
    },
  };
}
