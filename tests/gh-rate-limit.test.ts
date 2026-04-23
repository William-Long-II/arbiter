import { describe, expect, test } from "bun:test";
import { makeClient, parseRateLimitHeaders } from "../src/github/client.ts";

describe("parseRateLimitHeaders", () => {
  test("extracts remaining, limit, resetAt from string headers (Octokit's default)", () => {
    const rl = parseRateLimitHeaders({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4872",
      "x-ratelimit-reset": "1700000000",
    });
    expect(rl).not.toBeNull();
    expect(rl!.limit).toBe(5000);
    expect(rl!.remaining).toBe(4872);
    expect(rl!.resetAt).toBe(1700000000);
    expect(rl!.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("accepts numeric header values too (some transport layers pre-parse)", () => {
    const rl = parseRateLimitHeaders({
      "x-ratelimit-limit": 5000,
      "x-ratelimit-remaining": 100,
      "x-ratelimit-reset": 1700001234,
    });
    expect(rl).not.toBeNull();
    expect(rl!.remaining).toBe(100);
  });

  test("returns null when all three headers are missing (e.g. GraphQL)", () => {
    expect(parseRateLimitHeaders({})).toBeNull();
  });

  test("returns null when any one header is missing", () => {
    expect(
      parseRateLimitHeaders({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "100",
        // missing reset
      }),
    ).toBeNull();
  });

  test("returns null when a header is present but not a number", () => {
    expect(
      parseRateLimitHeaders({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "100",
        "x-ratelimit-reset": "not-a-number",
      }),
    ).toBeNull();
  });

  test("returns null when a header is an empty string", () => {
    expect(
      parseRateLimitHeaders({
        "x-ratelimit-limit": "",
        "x-ratelimit-remaining": "100",
        "x-ratelimit-reset": "1700000000",
      }),
    ).toBeNull();
  });
});

describe("makeClient", () => {
  test("without onRateLimit works (backward compatible)", () => {
    const gh = makeClient("token");
    expect(gh).toBeDefined();
    // The hook collection exists (as a callable in recent Octokits);
    // we only care that construction didn't throw.
    expect(gh.hook).toBeDefined();
  });

  test("with onRateLimit returns a functional Octokit instance", () => {
    const gh = makeClient("token", { onRateLimit: () => {} });
    expect(gh).toBeDefined();
  });
});
