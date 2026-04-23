import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/state/db.ts";
import { loadConfigFromStore } from "../src/config.ts";

function tmpDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "auto-reviewer-test-"));
  return {
    path: join(dir, "state.sqlite"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows WAL handle quirk, tolerated
      }
    },
  };
}

describe("review.concurrency", () => {
  test("defaults to 1 when unset", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const cfg = loadConfigFromStore(store);
      expect(cfg.review.concurrency).toBe(1);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("round-trips a valid value", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.setScalar("review.concurrency", "3");
      const cfg = loadConfigFromStore(store);
      expect(cfg.review.concurrency).toBe(3);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("zod rejects values outside 1-4", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.setScalar("review.concurrency", "5");
      // zod should refuse max > 4 — the caller throws with a diagnostic
      expect(() => loadConfigFromStore(store)).toThrow(/concurrency/i);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("non-integer string falls back to default (via asInt)", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      store.setScalar("review.concurrency", "not-a-number");
      const cfg = loadConfigFromStore(store);
      expect(cfg.review.concurrency).toBe(1);
      store.close();
    } finally {
      cleanup();
    }
  });
});

describe("worker pool semantics", () => {
  // Mirrors the pool in runTick. If the real thing is ever extracted,
  // point these tests at it. For now, the tests assert the properties the
  // production code relies on.
  async function runPool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
    const queue = [...items];
    const workers = Array.from({ length: n }, async () => {
      while (true) {
        const item = queue.shift();
        if (!item) return;
        await fn(item);
      }
    });
    await Promise.all(workers);
  }

  test("processes every item exactly once", async () => {
    const seen = new Set<number>();
    await runPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
      expect(seen.has(n)).toBe(false);
      seen.add(n);
    });
    expect(seen.size).toBe(10);
  });

  test("respects concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    await runPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async () => {
      active += 1;
      if (active > peak) peak = active;
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // actually parallelizing, not serial
  });

  test("a single worker still drains the queue", async () => {
    const out: number[] = [];
    await runPool([1, 2, 3], 1, async (n) => {
      out.push(n);
    });
    expect(out).toEqual([1, 2, 3]);
  });

  test("empty queue returns immediately without error", async () => {
    await expect(runPool<number>([], 4, async () => {})).resolves.toBeUndefined();
  });

  test("one worker's slow item does not block others", async () => {
    const done: number[] = [];
    await runPool([1, 2, 3, 4, 5], 3, async (n) => {
      await new Promise((r) => setTimeout(r, n === 1 ? 50 : 5));
      done.push(n);
    });
    // 1 starts first but finishes last because it's the slowest.
    expect(done[done.length - 1]).toBe(1);
  });
});
