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

describe("webhook deliveries", () => {
  test("first insert returns false (not duplicate); second returns true", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const first = store.recordWebhookDelivery({
        delivery_id: "abc-123",
        event_type: "pull_request",
      });
      expect(first).toBe(false);
      expect(store.hasWebhookDelivery("abc-123")).toBe(true);

      const second = store.recordWebhookDelivery({
        delivery_id: "abc-123",
        event_type: "pull_request",
      });
      expect(second).toBe(true);

      store.close();
    } finally {
      cleanup();
    }
  });

  test("hasWebhookDelivery is false for unseen ids", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      expect(store.hasWebhookDelivery("never-seen")).toBe(false);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("pruneWebhookDeliveries drops rows older than N days", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      // Insert three deliveries with engineered received_at by hitting the
      // underlying table directly — the public API sets 'now' automatically.
      const insert = store.db.prepare(
        `INSERT INTO webhook_deliveries(delivery_id, event_type, received_at) VALUES (?, 'x', ?)`,
      );
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      insert.run("old-45d", new Date(now - 45 * day).toISOString());
      insert.run("mid-15d", new Date(now - 15 * day).toISOString());
      insert.run("fresh-1d", new Date(now - 1 * day).toISOString());

      expect(store.pruneWebhookDeliveries(30)).toBe(1);
      expect(store.hasWebhookDelivery("old-45d")).toBe(false);
      expect(store.hasWebhookDelivery("mid-15d")).toBe(true);
      expect(store.hasWebhookDelivery("fresh-1d")).toBe(true);

      // Zero / negative → no-op.
      expect(store.pruneWebhookDeliveries(0)).toBe(0);
      expect(store.pruneWebhookDeliveries(-5)).toBe(0);

      store.close();
    } finally {
      cleanup();
    }
  });
});
