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

describe("tone templates storage", () => {
  test("insert + list orders by priority asc then id asc", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const idA = store.insertToneTemplate({
        pattern: "**/*.tsx",
        tone_addendum: "React a11y",
        priority: 10,
      });
      const idB = store.insertToneTemplate({
        pattern: "**/*.tf",
        tone_addendum: "Terraform",
        priority: 0,
      });
      const idC = store.insertToneTemplate({
        pattern: "**/migrations/**",
        tone_addendum: "Migrations",
        priority: 0,
      });
      const rows = store.listToneTemplates();
      expect(rows.map((r) => r.id)).toEqual([idB, idC, idA]);
      expect(rows[0]!.pattern).toBe("**/*.tf");
      expect(rows[0]!.priority).toBe(0);
      expect(rows[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("getToneTemplate returns null when id is missing", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      expect(store.getToneTemplate(9999)).toBeNull();
      const id = store.insertToneTemplate({
        pattern: "**/*.go",
        tone_addendum: "Go",
        priority: 1,
      });
      expect(store.getToneTemplate(id)?.pattern).toBe("**/*.go");
      store.close();
    } finally {
      cleanup();
    }
  });

  test("updateToneTemplate overwrites pattern/addendum/priority", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const id = store.insertToneTemplate({
        pattern: "**/*.go",
        tone_addendum: "Go",
        priority: 1,
      });
      store.updateToneTemplate({
        id,
        pattern: "**/*.rs",
        tone_addendum: "Rust: unsafe, lifetimes, panics.",
        priority: 7,
      });
      const row = store.getToneTemplate(id)!;
      expect(row.pattern).toBe("**/*.rs");
      expect(row.tone_addendum).toBe("Rust: unsafe, lifetimes, panics.");
      expect(row.priority).toBe(7);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("deleteToneTemplate removes the row", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const id = store.insertToneTemplate({
        pattern: "**/*.py",
        tone_addendum: "Py",
        priority: 0,
      });
      expect(store.listToneTemplates()).toHaveLength(1);
      store.deleteToneTemplate(id);
      expect(store.listToneTemplates()).toHaveLength(0);
      expect(store.getToneTemplate(id)).toBeNull();
      store.close();
    } finally {
      cleanup();
    }
  });
});
