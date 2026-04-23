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

describe("users + sessions storage", () => {
  test("countUsers is 0 on a fresh DB", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      expect(store.countUsers()).toBe(0);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("upsertUser inserts on first call, returns true; updates email but preserves role on second", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const firstTime = store.upsertUser({
        login: "alice",
        email: "alice@example.com",
        roleIfNew: "admin",
      });
      expect(firstTime).toBe(true);
      expect(store.getUser("alice")?.role).toBe("admin");

      const secondTime = store.upsertUser({
        login: "alice",
        email: "alice@new.com",
        roleIfNew: "viewer", // ignored on existing user
      });
      expect(secondTime).toBe(false);
      const u = store.getUser("alice")!;
      expect(u.email).toBe("alice@new.com");
      expect(u.role).toBe("admin"); // NOT downgraded
      store.close();
    } finally {
      cleanup();
    }
  });

  test("setUserRole changes the role and bumps updated_at", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.upsertUser({ login: "bob", email: null, roleIfNew: "viewer" });
      const before = store.getUser("bob")!;
      // Tiny delay so the updated_at ISO string differs.
      await new Promise((r) => setTimeout(r, 5));
      store.setUserRole("bob", "admin");
      const after = store.getUser("bob")!;
      expect(after.role).toBe("admin");
      expect(after.updated_at >= before.updated_at).toBe(true);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("listUsers returns alphabetical order", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.upsertUser({ login: "charlie", email: null, roleIfNew: "viewer" });
      store.upsertUser({ login: "alice", email: null, roleIfNew: "admin" });
      store.upsertUser({ login: "bob", email: null, roleIfNew: "viewer" });
      expect(store.listUsers().map((u) => u.login)).toEqual(["alice", "bob", "charlie"]);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("deleteUser cascades to sessions via foreign key", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.upsertUser({ login: "alice", email: null, roleIfNew: "admin" });
      const futureIso = new Date(Date.now() + 60_000).toISOString();
      store.createSession({
        token_hash: "hash-a",
        user_login: "alice",
        expires_at: futureIso,
      });
      expect(store.getSession("hash-a")).not.toBeNull();

      store.deleteUser("alice");
      expect(store.getUser("alice")).toBeNull();
      expect(store.getSession("hash-a")).toBeNull();
      store.close();
    } finally {
      cleanup();
    }
  });

  test("deleteSessionsForUser removes only that user's sessions", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.upsertUser({ login: "alice", email: null, roleIfNew: "admin" });
      store.upsertUser({ login: "bob", email: null, roleIfNew: "viewer" });
      const future = new Date(Date.now() + 60_000).toISOString();
      store.createSession({ token_hash: "a1", user_login: "alice", expires_at: future });
      store.createSession({ token_hash: "a2", user_login: "alice", expires_at: future });
      store.createSession({ token_hash: "b1", user_login: "bob", expires_at: future });

      store.deleteSessionsForUser("alice");
      expect(store.getSession("a1")).toBeNull();
      expect(store.getSession("a2")).toBeNull();
      expect(store.getSession("b1")).not.toBeNull();
      store.close();
    } finally {
      cleanup();
    }
  });

  test("pruneExpiredSessions removes rows whose expires_at is in the past, leaves future ones", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.upsertUser({ login: "alice", email: null, roleIfNew: "admin" });
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      store.createSession({ token_hash: "dead", user_login: "alice", expires_at: past });
      store.createSession({ token_hash: "live", user_login: "alice", expires_at: future });

      expect(store.pruneExpiredSessions()).toBe(1);
      expect(store.getSession("dead")).toBeNull();
      expect(store.getSession("live")).not.toBeNull();
      store.close();
    } finally {
      cleanup();
    }
  });

  test("touchSession updates last_seen_at without rebuilding the row", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.upsertUser({ login: "alice", email: null, roleIfNew: "admin" });
      const future = new Date(Date.now() + 60_000).toISOString();
      store.createSession({ token_hash: "h", user_login: "alice", expires_at: future });
      const before = store.getSession("h")!;
      await new Promise((r) => setTimeout(r, 5));
      store.touchSession("h");
      const after = store.getSession("h")!;
      expect(after.created_at).toBe(before.created_at);
      expect(after.expires_at).toBe(before.expires_at);
      expect(after.last_seen_at > before.last_seen_at).toBe(true);
      store.close();
    } finally {
      cleanup();
    }
  });
});
