import { describe, expect, test, beforeEach } from "bun:test";
import type { Octokit } from "../src/github/client";
import {
  fetchConventions,
  conventionsCache,
  type ConventionsResult,
} from "../src/review/conventions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Octokit-like stub whose getContent calls we control. */
function makeOctokit(
  responses: Record<string, { type: string; content?: string; encoding?: string } | "404" | "500">,
): { octokit: Octokit; calls: string[] } {
  const calls: string[] = [];
  const octokit = {
    repos: {
      getContent: async ({
        owner,
        repo,
        path,
        ref,
      }: {
        owner: string;
        repo: string;
        path: string;
        ref: string;
      }) => {
        calls.push(`${owner}/${repo}/${path}@${ref}`);
        const key = path;
        const stub = responses[key];
        if (stub === "404") {
          const err = Object.assign(new Error("Not Found"), { status: 404 });
          throw err;
        }
        if (stub === "500") {
          const err = Object.assign(new Error("Internal Server Error"), { status: 500 });
          throw err;
        }
        if (!stub) {
          const err = Object.assign(new Error("Not Found"), { status: 404 });
          throw err;
        }
        return { data: stub };
      },
    },
  } as unknown as Octokit;
  return { octokit, calls };
}

/** Encode a string as base64 content the way GitHub returns it. */
function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

/** Build a file-response entry for makeOctokit. */
function fileEntry(content: string) {
  return { type: "file", content: b64(content), encoding: "base64" };
}

// Ensure cache is clean between tests.
beforeEach(() => {
  // Clear by reaching in and resetting the internal map — we expose the cache
  // singleton purely for this purpose.
  // We do this by deleting each key we might have set; or we can just call
  // the delete method for test keys. Since the cache is module-level and we
  // can't replace the Map directly, we clear known test keys by calling
  // conventionsCache.delete(). In practice tests use unique owners/repos/refs.
  // The simplest approach: expose a clear() that tests can call.
  // Since we don't have that, each test uses a unique ref to force misses.
  // (No action needed here — handled by unique keys per test.)
});

// ---------------------------------------------------------------------------
// File ordering tests
// ---------------------------------------------------------------------------

describe("fetchConventions – ordering", () => {
  test("returns files in canonical order (CLAUDE.md first, .github/copilot-instructions.md last)", async () => {
    const { octokit } = makeOctokit({
      "CONTRIBUTING.md": fileEntry("contributing content"),
      "CLAUDE.md": fileEntry("claude content"),
      ".cursorrules": fileEntry("cursor rules"),
      "AGENTS.md": fileEntry("agents content"),
      ".github/copilot-instructions.md": fileEntry("copilot instructions"),
    });

    const result = await fetchConventions({ octokit, owner: "acme", repo: "test", ref: "order-1" });

    const paths = result.sections.map((s) => s.path);
    expect(paths).toEqual([
      "CLAUDE.md",
      "AGENTS.md",
      "CONTRIBUTING.md",
      ".cursorrules",
      ".github/copilot-instructions.md",
    ]);
  });

  test("skips missing files and preserves order of found files", async () => {
    const { octokit } = makeOctokit({
      "CLAUDE.md": fileEntry("hello"),
      ".cursorrules": fileEntry("rules"),
      // AGENTS.md, CONTRIBUTING.md, .github/copilot-instructions.md → 404
    });

    const result = await fetchConventions({ octokit, owner: "acme", repo: "test", ref: "order-2" });
    expect(result.sections.map((s) => s.path)).toEqual(["CLAUDE.md", ".cursorrules"]);
  });
});

// ---------------------------------------------------------------------------
// Per-file cap (16 KB)
// ---------------------------------------------------------------------------

describe("fetchConventions – per-file 16 KB cap", () => {
  const PER_FILE_CAP = 16 * 1024;

  test("content within cap is returned verbatim and truncated=false", async () => {
    const content = "a".repeat(100);
    const { octokit } = makeOctokit({ "CLAUDE.md": fileEntry(content) });

    const result = await fetchConventions({ octokit, owner: "acme", repo: "cap1", ref: "cap-1" });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.truncated).toBe(false);
    expect(result.sections[0]!.content).toBe(content);
  });

  test("content exceeding 16 KB is truncated and truncated=true", async () => {
    const content = "b".repeat(PER_FILE_CAP + 500);
    const { octokit } = makeOctokit({ "CLAUDE.md": fileEntry(content) });

    const result = await fetchConventions({ octokit, owner: "acme", repo: "cap2", ref: "cap-2" });
    expect(result.sections).toHaveLength(1);
    const sec = result.sections[0]!;
    expect(sec.truncated).toBe(true);
    expect(sec.content).toContain("[...truncated]");
    // Must start with the first 16 KB of the raw content.
    expect(sec.content.startsWith("b".repeat(PER_FILE_CAP))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Total 48 KB cap
// ---------------------------------------------------------------------------

describe("fetchConventions – total 48 KB cap", () => {
  const PER_FILE_CAP = 16 * 1024;
  const TOTAL_CAP = 48 * 1024;

  test("total bytes stay at or below 48 KB when multiple large files are fetched", async () => {
    // Each file is exactly 16 KB — the total would be 80 KB without the cap.
    const big = "x".repeat(PER_FILE_CAP);
    const { octokit } = makeOctokit({
      "CLAUDE.md": fileEntry(big),
      "AGENTS.md": fileEntry(big),
      "CONTRIBUTING.md": fileEntry(big),
      ".cursorrules": fileEntry(big),
      ".github/copilot-instructions.md": fileEntry(big),
    });

    const result = await fetchConventions({ octokit, owner: "acme", repo: "totalcap", ref: "tc-1" });

    expect(result.totalBytes).toBeLessThanOrEqual(TOTAL_CAP + "[...truncated]\n\n".length * 5);
    // Only 3 files should fit (3 × 16 KB = 48 KB).
    expect(result.sections.length).toBeLessThanOrEqual(3);
  });

  test("truncation marker is present when a file pushes past the total cap mid-content", async () => {
    // CLAUDE.md = 32 KB (fills half the total budget).
    // AGENTS.md = 32 KB (only 16 KB of budget left, so this one is truncated mid-file).
    const thirtyTwoKb = "y".repeat(32 * 1024);
    const { octokit } = makeOctokit({
      "CLAUDE.md": fileEntry(thirtyTwoKb),
      "AGENTS.md": fileEntry(thirtyTwoKb),
    });

    const result = await fetchConventions({ octokit, owner: "acme", repo: "totalcap2", ref: "tc-2" });

    // CLAUDE.md fits in full (32 KB ≤ 16 KB per-file cap is false; it is > 16 KB → truncated by per-file cap)
    // Actually 32 KB > 16 KB per-file cap → CLAUDE.md itself gets truncated.
    // After CLAUDE.md: totalBytes = 16 KB + marker length (~18 B)
    // AGENTS.md: 32 KB raw, per-file cap → 16 KB; remaining budget ≈ 32 KB − 16KB − 18 = ~16 KB − 18 B
    // The remaining budget for AGENTS.md = ~16 KB - 18 B, which is < 16 KB, so it gets truncated by total cap too.
    const truncatedSections = result.sections.filter((s) => s.truncated);
    expect(truncatedSections.length).toBeGreaterThan(0);
    expect(truncatedSections.some((s) => s.content.includes("[...truncated]"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 404 handling
// ---------------------------------------------------------------------------

describe("fetchConventions – 404 handling", () => {
  test("single 404 is silent — returns no section for that file", async () => {
    const { octokit } = makeOctokit({
      "CLAUDE.md": "404",
      "CONTRIBUTING.md": fileEntry("contributing"),
    });

    const result = await fetchConventions({ octokit, owner: "acme", repo: "404test", ref: "404-1" });
    expect(result.sections.map((s) => s.path)).toEqual(["CONTRIBUTING.md"]);
  });

  test("all files 404 → empty sections array", async () => {
    const { octokit } = makeOctokit({});

    const result = await fetchConventions({ octokit, owner: "acme", repo: "404all", ref: "404-2" });
    expect(result.sections).toHaveLength(0);
    expect(result.totalBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 500 / unexpected error handling
// ---------------------------------------------------------------------------

describe("fetchConventions – error handling (non-404)", () => {
  test("500 on one file does not throw and returns the other files that succeeded", async () => {
    const { octokit } = makeOctokit({
      "CLAUDE.md": "500",
      "CONTRIBUTING.md": fileEntry("contributing content"),
    });

    // Should not throw.
    let result: ConventionsResult | undefined;
    expect(async () => {
      result = await fetchConventions({ octokit, owner: "acme", repo: "500test", ref: "500-1" });
    }).not.toThrow();

    result = await fetchConventions({ octokit, owner: "acme", repo: "500test2", ref: "500-2" });
    expect(result.sections.map((s) => s.path)).toEqual(["CONTRIBUTING.md"]);
  });
});

// ---------------------------------------------------------------------------
// Cache hit / miss
// ---------------------------------------------------------------------------

describe("fetchConventions – cache", () => {
  test("two consecutive calls with the same key call Octokit once", async () => {
    const { octokit, calls } = makeOctokit({
      "CLAUDE.md": fileEntry("cached content"),
    });

    const ref = "cache-hit-1";
    await fetchConventions({ octokit, owner: "org", repo: "repo", ref });
    await fetchConventions({ octokit, owner: "org", repo: "repo", ref });

    // Only one real fetch per file — the second call is served from cache.
    const claudeCalls = calls.filter((c) => c.includes("CLAUDE.md"));
    expect(claudeCalls).toHaveLength(1);
  });

  test("different ref calls Octokit twice", async () => {
    const { octokit, calls } = makeOctokit({
      "CLAUDE.md": fileEntry("v1"),
    });

    await fetchConventions({ octokit, owner: "org", repo: "repo", ref: "sha-ref-A" });
    await fetchConventions({ octokit, owner: "org", repo: "repo", ref: "sha-ref-B" });

    const claudeCalls = calls.filter((c) => c.includes("CLAUDE.md"));
    expect(claudeCalls).toHaveLength(2);
  });

  test("TTL expiry causes a second Octokit call", async () => {
    const { octokit, calls } = makeOctokit({
      "CLAUDE.md": fileEntry("ttl-content"),
    });

    const ref = "ttl-test-ref";
    const cacheKey = `org/ttlrepo@${ref}`;

    await fetchConventions({ octokit, owner: "org", repo: "ttlrepo", ref });
    const firstCallCount = calls.filter((c) => c.includes("CLAUDE.md")).length;
    expect(firstCallCount).toBe(1);

    // Simulate TTL expiry by deleting the cache entry directly.
    conventionsCache.delete(cacheKey);

    await fetchConventions({ octokit, owner: "org", repo: "ttlrepo", ref });
    const secondCallCount = calls.filter((c) => c.includes("CLAUDE.md")).length;
    expect(secondCallCount).toBe(2);
  });
});
