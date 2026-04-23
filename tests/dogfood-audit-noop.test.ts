import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/state/db.ts";
import { handleOrgsPost, handleReposPost } from "../src/web/routes/config.ts";

/**
 * Dogfood-surfaced bug: hitting delete on a nonexistent org/repo
 * (via a stale tab, a direct curl, or a form double-submit after the
 * row was already removed) used to silently succeed AND write an
 * `audit.config.*.delete` event for the fictional entity. The audit
 * log should be a record of actual state changes, not button presses.
 */

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

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

describe("handleOrgsPost delete idempotency", () => {
  test("delete of a nonexistent org → no audit row written, but 303 is fine", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const before = store.recentEvents(50).length;
      const res = handleOrgsPost(store, fd({ _action: "delete", name: "does-not-exist" }));
      expect(res.ok).toBe(true);
      const after = store.recentEvents(50);
      expect(after.length).toBe(before);
      // Defensive: explicitly confirm no audit.config.org.delete row landed.
      expect(after.some((e) => e.kind === "audit.config.org.delete")).toBe(false);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("delete of a real org still writes its audit row", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.upsertOrg({
        name: "acme",
        mode: "all",
        include_json: "[]",
        exclude_json: "[]",
        tone_override: null,
        tone_mode: "append",
      });
      const res = handleOrgsPost(store, fd({ _action: "delete", name: "acme" }));
      expect(res.ok).toBe(true);
      const events = store.recentEvents(50);
      expect(events.some((e) => e.kind === "audit.config.org.delete")).toBe(true);
      expect(store.getOrg("acme")).toBeNull();
      store.close();
    } finally {
      cleanup();
    }
  });
});

describe("handleReposPost delete idempotency", () => {
  test("delete of a nonexistent repo → no audit row", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const before = store.recentEvents(50).length;
      const res = handleReposPost(store, fd({ _action: "delete", slug: "no/such-repo" }));
      expect(res.ok).toBe(true);
      const after = store.recentEvents(50);
      expect(after.length).toBe(before);
      expect(after.some((e) => e.kind === "audit.config.repo.delete")).toBe(false);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("delete of a real repo still writes its audit row", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.addWatchedRepo("org/repo");
      const res = handleReposPost(store, fd({ _action: "delete", slug: "org/repo" }));
      expect(res.ok).toBe(true);
      const events = store.recentEvents(50);
      expect(events.some((e) => e.kind === "audit.config.repo.delete")).toBe(true);
      expect(store.getRepo("org/repo")).toBeNull();
      store.close();
    } finally {
      cleanup();
    }
  });
});
