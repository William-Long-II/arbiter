/**
 * Tests for src/review/result-cache.ts (unit) and the result-cache integration
 * in runReview (integration).
 *
 * TTL expiry is tested via the module-level singleton's internal state — we
 * manipulate Date.now() via Bun's fake-timers API where available, and fall
 * back to directly calling `clear()` / testing size() to verify eviction
 * without needing real wall-clock time.
 */

import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  spyOn,
  mock,
} from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { PullRequestDiff } from "../src/github";
import type { Intent } from "../src/jira";
import type { RunReviewOutput } from "../src/review/types";
import { resultCache } from "../src/review/result-cache";
import { runReview } from "../src/review";
import * as synthesizeModule from "../src/review/synthesize";
import * as usageModule from "../src/review/usage";
import * as metricsModule from "../src/server/metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutput(summary = "looks good"): RunReviewOutput {
  return {
    result: { verdict: "approve", summary, lineComments: [] },
    warnings: [],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function makeDiff(
  headSha = "sha-abc",
  owner = "acme",
  repo = "widget",
  patchChars = 100,
): PullRequestDiff {
  return {
    owner,
    repo,
    number: 1,
    headSha,
    baseSha: "base-sha",
    title: "title",
    body: "body",
    files: [
      {
        filename: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "x".repeat(patchChars),
      },
    ],
    totals: { additions: 1, deletions: 0, changedFiles: 1 },
  };
}

const intent: Intent = {
  source: "jira",
  ticketKey: "PROJ-1",
  title: "do the thing",
  description: "do it",
  warnings: [],
};

function makeAnthropicStub(output: RunReviewOutput["result"]) {
  let callCount = 0;
  const stub = {
    messages: {
      parse: async (_params: Record<string, unknown>) => {
        callCount++;
        return {
          parsed_output: output,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        };
      },
    },
  } as unknown as Anthropic;
  return { stub, getCallCount: () => callCount };
}

// ---------------------------------------------------------------------------
// Unit tests: resultCache standalone
// ---------------------------------------------------------------------------

describe("resultCache — get / set / clear", () => {
  beforeEach(() => {
    resultCache.clear();
  });

  test("get returns undefined for unknown key", () => {
    expect(resultCache.get("nonexistent@sha")).toBeUndefined();
  });

  test("set then get returns the same object reference", () => {
    const out = makeOutput("test");
    resultCache.set("acme/widget@sha1", out);
    expect(resultCache.get("acme/widget@sha1")).toBe(out);
  });

  test("clear removes all entries", () => {
    resultCache.set("acme/a@sha1", makeOutput());
    resultCache.set("acme/b@sha2", makeOutput());
    expect(resultCache.size()).toBe(2);
    resultCache.clear();
    expect(resultCache.size()).toBe(0);
    expect(resultCache.get("acme/a@sha1")).toBeUndefined();
  });

  test("different head SHAs produce separate cache entries", () => {
    const out1 = makeOutput("first sha");
    const out2 = makeOutput("second sha");
    resultCache.set("acme/widget@sha-A", out1);
    resultCache.set("acme/widget@sha-B", out2);
    expect(resultCache.get("acme/widget@sha-A")).toBe(out1);
    expect(resultCache.get("acme/widget@sha-B")).toBe(out2);
    // Entries are independent — fetching B does not evict A.
    expect(resultCache.get("acme/widget@sha-A")).toBe(out1);
  });

  test("same key updated: get returns the newer value", () => {
    const out1 = makeOutput("v1");
    const out2 = makeOutput("v2");
    resultCache.set("acme/widget@sha-update", out1);
    resultCache.set("acme/widget@sha-update", out2);
    expect(resultCache.get("acme/widget@sha-update")).toBe(out2);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: LRU eviction
// ---------------------------------------------------------------------------

describe("resultCache — LRU eviction", () => {
  // We need a small-cap cache for eviction tests.  Since resultCache is a
  // module-level singleton with cap=500 we can test eviction behaviour by
  // filling it to (cap + 1) entries.  Instead, we test the observable
  // behaviour using the exported singleton directly.
  //
  // Strategy: fill 500 entries (the cap), then add one more and verify the
  // oldest entry was evicted.
  test("oldest entry is evicted when cap is exceeded", () => {
    resultCache.clear();
    const CACHE_MAX = 500;

    // Insert CACHE_MAX entries — first one will be LRU.
    const oldestKey = "lru-test/repo@sha-oldest";
    const oldestValue = makeOutput("oldest");
    resultCache.set(oldestKey, oldestValue);

    for (let i = 1; i < CACHE_MAX; i++) {
      resultCache.set(`lru-test/repo@sha-${i}`, makeOutput(`entry-${i}`));
    }
    expect(resultCache.size()).toBe(CACHE_MAX);

    // Adding one more entry beyond the cap should evict the oldest.
    resultCache.set("lru-test/repo@sha-overflow", makeOutput("overflow"));
    expect(resultCache.size()).toBe(CACHE_MAX);
    expect(resultCache.get(oldestKey)).toBeUndefined();
  });

  test("recently accessed entry is NOT evicted when a newer entry triggers eviction", () => {
    resultCache.clear();
    const CACHE_MAX = 500;

    const touchedKey = "lru-test/repo@sha-touched";
    resultCache.set(touchedKey, makeOutput("touched"));

    // Fill the rest of the cache so it's at capacity.
    for (let i = 0; i < CACHE_MAX - 1; i++) {
      resultCache.set(`lru-test2/repo@sha-fill-${i}`, makeOutput(`fill-${i}`));
    }
    expect(resultCache.size()).toBe(CACHE_MAX);

    // Touch (access) the first entry to promote it to MRU.
    const touchedBefore = resultCache.get(touchedKey);
    expect(touchedBefore).toBeDefined();

    // Adding one more entry — should evict the true LRU, not `touchedKey`.
    resultCache.set("lru-test2/repo@sha-new-overflow", makeOutput("new-overflow"));

    // The touched entry should still be present.
    expect(resultCache.get(touchedKey)).toBeDefined();
    expect(resultCache.size()).toBe(CACHE_MAX);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: TTL expiry
// ---------------------------------------------------------------------------

describe("resultCache — TTL expiry", () => {
  const TTL_MS = 10 * 60 * 1_000; // 10 minutes

  beforeEach(() => {
    resultCache.clear();
  });

  test("entry is returned when accessed before TTL", () => {
    const realDateNow = Date.now;
    const fakeNow = 1_700_000_000_000;
    Date.now = () => fakeNow;

    try {
      const out = makeOutput("ttl-test");
      resultCache.set("ttl/repo@sha-live", out);
      // Access slightly before TTL.
      Date.now = () => fakeNow + TTL_MS - 1;
      expect(resultCache.get("ttl/repo@sha-live")).toBe(out);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("entry is evicted and undefined returned after TTL expires", () => {
    const realDateNow = Date.now;
    const fakeNow = 1_700_000_000_000;
    Date.now = () => fakeNow;

    try {
      const out = makeOutput("ttl-expired");
      resultCache.set("ttl/repo@sha-expired", out);
      // Advance time past TTL.
      Date.now = () => fakeNow + TTL_MS + 1;
      expect(resultCache.get("ttl/repo@sha-expired")).toBeUndefined();
    } finally {
      Date.now = realDateNow;
    }
  });

  test("expired entry does not consume capacity (can be replaced)", () => {
    const realDateNow = Date.now;
    const fakeNow = 1_700_000_000_000;
    Date.now = () => fakeNow;

    try {
      resultCache.set("ttl/repo@sha-replace", makeOutput("old"));
      // Expire.
      Date.now = () => fakeNow + TTL_MS + 1;
      expect(resultCache.get("ttl/repo@sha-replace")).toBeUndefined();
      // Insert a fresh entry with the same key.
      Date.now = () => fakeNow + TTL_MS + 2;
      const fresh = makeOutput("fresh");
      resultCache.set("ttl/repo@sha-replace", fresh);
      expect(resultCache.get("ttl/repo@sha-replace")).toBe(fresh);
    } finally {
      Date.now = realDateNow;
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests: runReview cache behaviour
// ---------------------------------------------------------------------------

describe("runReview — result cache integration", () => {
  let originalMode: string | undefined;
  let recordUsageSpy: ReturnType<typeof spyOn<typeof usageModule, "recordUsage">>;
  let incReviewCacheSpy: ReturnType<typeof spyOn<typeof metricsModule, "incReviewCache">>;

  beforeEach(() => {
    resultCache.clear();
    originalMode = process.env["REVIEW_MODE"];
    delete process.env["REVIEW_MODE"]; // default auto
    recordUsageSpy = spyOn(usageModule, "recordUsage").mockResolvedValue(undefined);
    incReviewCacheSpy = spyOn(metricsModule, "incReviewCache").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env["REVIEW_MODE"];
    } else {
      process.env["REVIEW_MODE"] = originalMode;
    }
    resultCache.clear();
    recordUsageSpy.mockRestore();
    incReviewCacheSpy.mockRestore();
  });

  test("cache hit: second call returns same object reference, Anthropic called only once", async () => {
    const { stub, getCallCount } = makeAnthropicStub({
      verdict: "approve",
      summary: "all good",
      lineComments: [],
    });

    const input = { intent, diff: makeDiff("sha-cache-hit-1") };

    const first = await runReview(stub, input);
    const second = await runReview(stub, input);

    // LLM was invoked only once.
    expect(getCallCount()).toBe(1);
    // Both calls return the same cached object.
    expect(second).toBe(first);
  });

  test("cache hit: metric {result:'hit'} incremented on second call", async () => {
    const { stub } = makeAnthropicStub({
      verdict: "approve",
      summary: "hit metric test",
      lineComments: [],
    });

    const input = { intent, diff: makeDiff("sha-cache-hit-metric") };

    await runReview(stub, input); // miss
    await runReview(stub, input); // hit

    const hitCalls = incReviewCacheSpy.mock.calls.filter(
      (c) => c[0] === "hit",
    );
    expect(hitCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("cache miss: metric {result:'miss'} incremented on first call", async () => {
    const { stub } = makeAnthropicStub({
      verdict: "comment",
      summary: "miss metric test",
      lineComments: [],
    });

    await runReview(stub, { intent, diff: makeDiff("sha-cache-miss-metric") });

    const missCalls = incReviewCacheSpy.mock.calls.filter(
      (c) => c[0] === "miss",
    );
    expect(missCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("different head SHAs get separate cache entries and both trigger LLM calls", async () => {
    const { stub, getCallCount } = makeAnthropicStub({
      verdict: "approve",
      summary: "separate shas",
      lineComments: [],
    });

    await runReview(stub, { intent, diff: makeDiff("sha-A-separate") });
    await runReview(stub, { intent, diff: makeDiff("sha-B-separate") });

    // Each unique SHA was a cache miss — LLM called twice.
    expect(getCallCount()).toBe(2);
  });

  test("same head SHA, same repo: second call is a cache hit (LLM called once)", async () => {
    const { stub, getCallCount } = makeAnthropicStub({
      verdict: "approve",
      summary: "same sha same repo",
      lineComments: [],
    });
    const diff = makeDiff("sha-same", "org", "myrepo");

    await runReview(stub, { intent, diff });
    await runReview(stub, { intent, diff });

    expect(getCallCount()).toBe(1);
  });

  test("chunked review with pass-2 overflow warning: NOT cached (set spy)", async () => {
    process.env["REVIEW_MODE"] = "chunked";

    const overflowOutput: RunReviewOutput = {
      result: { verdict: "comment", summary: "overflow result", lineComments: [] },
      warnings: ["[chunked-review] pass-2 overflow: synthesis truncated"],
    };

    // Spy on runChunkedReview to return the overflow output.
    const chunkedSpy = spyOn(
      synthesizeModule,
      "runChunkedReview",
    ).mockResolvedValue(overflowOutput);

    // Spy on resultCache.set to verify it is NOT called.
    const setCacheSpy = spyOn(resultCache, "set");

    const input = { intent, diff: makeDiff("sha-chunked-overflow") };
    const out = await runReview(
      {} as unknown as Anthropic,
      input,
    );

    // The overflow result is still returned to the caller.
    expect(out.warnings).toContain("[chunked-review] pass-2 overflow: synthesis truncated");

    // But it was NOT stored in the cache.
    expect(setCacheSpy).not.toHaveBeenCalled();

    chunkedSpy.mockRestore();
    setCacheSpy.mockRestore();
  });

  test("chunked review WITHOUT overflow warning: IS cached", async () => {
    process.env["REVIEW_MODE"] = "chunked";

    const cleanOutput: RunReviewOutput = {
      result: { verdict: "approve", summary: "clean chunked", lineComments: [] },
      warnings: [],
    };

    const chunkedSpy = spyOn(
      synthesizeModule,
      "runChunkedReview",
    ).mockResolvedValue(cleanOutput);

    const setCacheSpy = spyOn(resultCache, "set");

    const input = { intent, diff: makeDiff("sha-chunked-clean") };
    await runReview({} as unknown as Anthropic, input);

    // set() should have been called once with the clean result.
    expect(setCacheSpy).toHaveBeenCalledTimes(1);

    chunkedSpy.mockRestore();
    setCacheSpy.mockRestore();
  });
});
