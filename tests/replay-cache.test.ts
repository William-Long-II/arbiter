/**
 * Unit tests for src/server/replay-cache.ts
 *
 * All timing is injected via the `now` option so tests are deterministic and
 * never use real sleep/setTimeout.
 */

import { describe, expect, test } from "bun:test";
import { ReplayCache } from "../src/server/replay-cache";

const TTL_MS = 10 * 60 * 1_000; // 10 minutes, same as default

describe("ReplayCache.tryInsert", () => {
  test("first insert returns fresh=true", () => {
    const cache = new ReplayCache();
    expect(cache.tryInsert("delivery-1")).toEqual({ fresh: true });
  });

  test("second insert with same ID returns fresh=false (replay)", () => {
    const cache = new ReplayCache();
    cache.tryInsert("delivery-1");
    expect(cache.tryInsert("delivery-1")).toEqual({ fresh: false });
  });

  test("two different IDs with same payload both succeed", () => {
    const cache = new ReplayCache();
    // No false positives: uniqueness is keyed on delivery ID, not payload.
    expect(cache.tryInsert("delivery-A")).toEqual({ fresh: true });
    expect(cache.tryInsert("delivery-B")).toEqual({ fresh: true });
  });

  test("TTL expiry allows re-insert", () => {
    let fakeNow = 1_000_000;
    const cache = new ReplayCache({ ttlMs: TTL_MS, now: () => fakeNow });

    cache.tryInsert("delivery-1");
    expect(cache.tryInsert("delivery-1")).toEqual({ fresh: false });

    // Advance past TTL.
    fakeNow += TTL_MS + 1;
    expect(cache.tryInsert("delivery-1")).toEqual({ fresh: true });
  });

  test("entry exactly at expiry boundary is treated as expired", () => {
    let fakeNow = 1_000_000;
    const cache = new ReplayCache({ ttlMs: TTL_MS, now: () => fakeNow });

    cache.tryInsert("delivery-1");

    // Advance to exactly the expiry moment (expiry = fakeNow + TTL_MS; check at fakeNow + TTL_MS).
    fakeNow += TTL_MS;
    // expiry == now: expiry <= now is true → treated as expired.
    expect(cache.tryInsert("delivery-1")).toEqual({ fresh: true });
  });

  test("size() reflects live entries", () => {
    const cache = new ReplayCache();
    expect(cache.size()).toBe(0);
    cache.tryInsert("a");
    expect(cache.size()).toBe(1);
    cache.tryInsert("b");
    expect(cache.size()).toBe(2);
  });

  test("expired entries are pruned on insert, reducing size", () => {
    let fakeNow = 0;
    const cache = new ReplayCache({ ttlMs: 100, now: () => fakeNow });

    cache.tryInsert("a");
    cache.tryInsert("b");
    expect(cache.size()).toBe(2);

    fakeNow = 200; // both expired
    cache.tryInsert("c"); // triggers prune
    // "a" and "b" pruned, only "c" live.
    expect(cache.size()).toBe(1);
  });
});

describe("ReplayCache LRU eviction", () => {
  test("inserting beyond maxSize evicts oldest entry", () => {
    // Use a tiny cache so we can exercise eviction easily.
    const cache = new ReplayCache({ maxSize: 3, ttlMs: TTL_MS });

    cache.tryInsert("id-1");
    cache.tryInsert("id-2");
    cache.tryInsert("id-3");
    expect(cache.size()).toBe(3);

    // Inserting id-4 should evict id-1 (oldest).
    const result = cache.tryInsert("id-4");
    expect(result).toEqual({ fresh: true });
    expect(cache.size()).toBe(3);

    // id-1 was evicted, so re-inserting it is treated as fresh.
    expect(cache.tryInsert("id-1")).toEqual({ fresh: true });
  });

  test("eviction does not affect entries younger than evicted", () => {
    const cache = new ReplayCache({ maxSize: 2, ttlMs: TTL_MS });

    cache.tryInsert("old");
    cache.tryInsert("young");

    // Overflow: "old" evicted.
    cache.tryInsert("newest");

    // "young" and "newest" are still live.
    expect(cache.tryInsert("young")).toEqual({ fresh: false });
    expect(cache.tryInsert("newest")).toEqual({ fresh: false });
  });
});

describe("ReplayCache.clear", () => {
  test("clear empties the cache", () => {
    const cache = new ReplayCache();
    cache.tryInsert("x");
    cache.tryInsert("y");
    cache.clear();
    expect(cache.size()).toBe(0);
    // Previously-seen ids are forgotten after clear.
    expect(cache.tryInsert("x")).toEqual({ fresh: true });
  });
});

describe("ReplayCache restart behavior", () => {
  test("a new cache instance does not remember IDs from a previous instance", () => {
    // This documents the intentional design: after a process restart (new
    // cache), previously-seen delivery IDs are forgotten.  An attacker who
    // captures a delivery and replays it within the TTL window *after* a
    // restart would succeed.  This is accepted as out-of-scope per issue #22.
    const first = new ReplayCache();
    first.tryInsert("delivery-seen");

    const second = new ReplayCache();
    expect(second.tryInsert("delivery-seen")).toEqual({ fresh: true });
  });
});
