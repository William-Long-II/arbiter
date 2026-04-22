import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/state/db.ts";
import {
  bootstrapFromYaml,
  isConfigured,
  loadConfigFromStore,
} from "../src/config.ts";

function tmpDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "auto-reviewer-test-"));
  return {
    path: join(dir, "state.sqlite"),
    cleanup: () => {
      // Windows briefly keeps a handle on WAL/SHM files after close(); tolerate it.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // leave it for the OS temp cleaner
      }
    },
  };
}

describe("config store", () => {
  test("defaults round-trip when nothing is stored", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const cfg = loadConfigFromStore(store);
      expect(cfg.review.dry_run).toBe(true);
      expect(cfg.review.max_approvals_per_hour).toBe(10);
      expect(cfg.poll.interval_seconds).toBe(60);
      expect(cfg.claude.command).toBe("claude");
      expect(isConfigured(cfg)).toBe(false);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("setScalar persists and reads back via Config", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.setScalar("github.bot_username", "my-bot");
      store.setScalar("review.dry_run", "false");
      store.setScalar("review.max_approvals_per_hour", "25");
      store.setScalar("poll.interval_seconds", "120");
      store.addWatchedRepo("owner/repo-a");
      const cfg = loadConfigFromStore(store);
      expect(cfg.github.bot_username).toBe("my-bot");
      expect(cfg.review.dry_run).toBe(false);
      expect(cfg.review.max_approvals_per_hour).toBe(25);
      expect(cfg.poll.interval_seconds).toBe(120);
      expect(cfg.watch.repos.map((r) => r.slug)).toEqual(["owner/repo-a"]);
      expect(cfg.watch.repos[0]!.tone_override).toBeNull();
      expect(cfg.watch.repos[0]!.tone_mode).toBe("append");
      expect(isConfigured(cfg)).toBe(true);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("orgs round-trip include/exclude lists via JSON", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.setScalar("github.bot_username", "bot");
      store.upsertOrg({
        name: "acme",
        mode: "all",
        include_json: "[]",
        exclude_json: JSON.stringify(["archived", "legacy"]),
        tone_override: null,
        tone_mode: "append",
      });
      store.upsertOrg({
        name: "partner",
        mode: "include",
        include_json: JSON.stringify(["shared-lib"]),
        exclude_json: "[]",
        tone_override: "partner-specific guidance",
        tone_mode: "replace",
      });
      const cfg = loadConfigFromStore(store);
      expect(cfg.watch.orgs).toHaveLength(2);
      const acme = cfg.watch.orgs.find((o) => o.name === "acme")!;
      expect(acme.mode).toBe("all");
      expect(acme.exclude).toEqual(["archived", "legacy"]);
      expect(acme.tone_override).toBeNull();
      expect(acme.tone_mode).toBe("append");
      const partner = cfg.watch.orgs.find((o) => o.name === "partner")!;
      expect(partner.mode).toBe("include");
      expect(partner.include).toEqual(["shared-lib"]);
      expect(partner.tone_override).toBe("partner-specific guidance");
      expect(partner.tone_mode).toBe("replace");
      store.close();
    } finally {
      cleanup();
    }
  });

  test("skip_authors and watch_repos are additive + idempotent", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.addSkipAuthor("alice");
      store.addSkipAuthor("alice"); // duplicate ignored
      store.addSkipAuthor("bob");
      store.removeSkipAuthor("alice");
      expect(store.listSkipAuthors()).toEqual(["bob"]);

      store.addWatchedRepo("a/b");
      store.addWatchedRepo("a/b");
      store.addWatchedRepo("c/d");
      store.removeWatchedRepo("a/b");
      expect(store.listWatchedRepos()).toEqual(["c/d"]);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("bootstrapFromYaml imports once and is idempotent after", () => {
    const { path, cleanup } = tmpDb();
    const yamlPath = path + ".yaml";
    writeFileSync(
      yamlPath,
      `
github:
  bot_username: yaml-bot
  skip_authors: [you, teammate]
watch:
  orgs:
    - name: my-org
      mode: all
      exclude: [legacy]
  repos:
    - one/two
review:
  dry_run: false
  max_approvals_per_hour: 5
  tone: "tone from yaml"
poll:
  interval_seconds: 30
claude:
  command: claude
  timeout_seconds: 450
`,
      "utf8",
    );
    try {
      const store = openStore(path);
      const first = bootstrapFromYaml(store, yamlPath);
      expect(first).toBe(true);

      const cfg = loadConfigFromStore(store);
      expect(cfg.github.bot_username).toBe("yaml-bot");
      expect(cfg.github.skip_authors.sort()).toEqual(["teammate", "you"]);
      expect(cfg.watch.orgs).toHaveLength(1);
      expect(cfg.watch.orgs[0]!.exclude).toEqual(["legacy"]);
      expect(cfg.watch.repos.map((r) => r.slug)).toEqual(["one/two"]);
      expect(cfg.review.dry_run).toBe(false);
      expect(cfg.review.max_approvals_per_hour).toBe(5);
      expect(cfg.poll.interval_seconds).toBe(30);
      expect(cfg.claude.timeout_seconds).toBe(450);

      // Second call must be a no-op because bot_username is now set.
      const second = bootstrapFromYaml(store, yamlPath);
      expect(second).toBe(false);

      store.close();
    } finally {
      cleanup();
    }
  });

  test("events are recorded and returned newest-first", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.recordEvent({ level: "info", kind: "first", message: "one" });
      store.recordEvent({
        level: "error",
        kind: "second",
        message: "two",
        repo: "a/b",
        prNumber: 42,
      });
      const events = store.recentEvents(10);
      expect(events).toHaveLength(2);
      expect(events[0]!.kind).toBe("second");
      expect(events[0]!.repo).toBe("a/b");
      expect(events[0]!.pr_number).toBe(42);
      expect(events[1]!.kind).toBe("first");
      store.close();
    } finally {
      cleanup();
    }
  });

  test("clearDedupe without sha removes all rows for a PR, with sha only that one", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.recordReview({ repo: "a/b", prNumber: 1, headSha: "sha1", verdict: "approve" });
      store.recordReview({ repo: "a/b", prNumber: 1, headSha: "sha2", verdict: "dry_run" });
      store.recordReview({ repo: "a/b", prNumber: 2, headSha: "sha3", verdict: "approve" });

      // SHA-scoped: only sha1 is removed; sha2 on the same PR survives.
      const removedOne = store.clearDedupe("a/b", 1, "sha1");
      expect(removedOne).toBe(1);
      expect(store.hasReviewed("a/b", 1, "sha1")).toBe(false);
      expect(store.hasReviewed("a/b", 1, "sha2")).toBe(true);

      // PR-wide: both remaining rows for PR 1 are removed; PR 2 untouched.
      const removedAll = store.clearDedupe("a/b", 1);
      expect(removedAll).toBe(1);
      expect(store.hasReviewed("a/b", 1, "sha2")).toBe(false);
      expect(store.hasReviewed("a/b", 2, "sha3")).toBe(true);

      store.close();
    } finally {
      cleanup();
    }
  });

  test("opens cleanly on a pre-tones schema and adds the columns", async () => {
    // Simulate a DB created by an older version of this app: same tables,
    // but without the tone_override / tone_mode columns. openStore() should
    // migrate the schema forward without losing existing rows.
    const { path, cleanup } = tmpDb();
    try {
      const { Database } = await import("bun:sqlite");
      const legacy = new Database(path, { create: true });
      legacy.exec(`
        CREATE TABLE config_watch_orgs (
          name TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          include_json TEXT NOT NULL DEFAULT '[]',
          exclude_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE config_watch_repos (slug TEXT PRIMARY KEY);
        INSERT INTO config_watch_orgs(name, mode) VALUES ('legacy-org', 'all');
        INSERT INTO config_watch_repos(slug) VALUES ('legacy/repo');
      `);
      legacy.close();

      const store = openStore(path);
      const orgs = store.listOrgs();
      expect(orgs).toHaveLength(1);
      expect(orgs[0]!.name).toBe("legacy-org");
      expect(orgs[0]!.tone_override).toBeNull();
      expect(orgs[0]!.tone_mode).toBe("append");

      const repos = store.listWatchedRepoRows();
      expect(repos).toHaveLength(1);
      expect(repos[0]!.slug).toBe("legacy/repo");
      expect(repos[0]!.tone_override).toBeNull();
      expect(repos[0]!.tone_mode).toBe("append");

      store.close();
    } finally {
      cleanup();
    }
  });

  test("pruneEvents removes rows older than the window", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const insert = store.db.prepare(
        `INSERT INTO events(ts, level, kind, message) VALUES (?, 'info', 'x', ?)`,
      );
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      insert.run(new Date(now - 45 * day).toISOString(), "old-45d");
      insert.run(new Date(now - 20 * day).toISOString(), "mid-20d");
      insert.run(new Date(now - 1 * day).toISOString(), "fresh-1d");

      expect(store.pruneEvents(30)).toBe(1); // only 45d row
      const remaining = store.recentEvents(10).map((e) => e.message);
      expect(remaining).toContain("mid-20d");
      expect(remaining).toContain("fresh-1d");
      expect(remaining).not.toContain("old-45d");

      expect(store.pruneEvents(0)).toBe(0); // zero days = no-op guard
      expect(store.pruneEvents(-5)).toBe(0);

      store.close();
    } finally {
      cleanup();
    }
  });
});
