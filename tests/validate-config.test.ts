import { describe, expect, test } from "bun:test";
import { validateConfig, type Config } from "../src/config.ts";

function validConfig(overrides: Partial<Config["review"]> = {}): unknown {
  // Build an input that zod will accept — not full Config because `.default`d
  // fields are input-optional. Then we override specific parts to test each
  // rejection path.
  return {
    github: { bot_username: "my-bot", skip_authors: [] },
    watch: { orgs: [], repos: [{ slug: "a/b" }] },
    review: {
      tone: "t",
      max_approvals_per_hour: 10,
      ...overrides,
    },
    poll: { interval_seconds: 60 },
    claude: { command: "claude", timeout_seconds: 600 },
  };
}

describe("validateConfig", () => {
  test("accepts a well-formed candidate", () => {
    const r = validateConfig(validConfig());
    expect(r.ok).toBe(true);
  });

  test("empty bot_username is permitted (first-boot state)", () => {
    // isConfigured() guards the loop from running with no bot, so the
    // schema permits "" — the save-time form handler is what rejects empty.
    const r = validateConfig({
      ...(validConfig() as object),
      github: { bot_username: "", skip_authors: [] },
    });
    expect(r.ok).toBe(true);
  });

  test("invalid bot_username format is rejected", () => {
    const cases = [
      "-starts-with-hyphen",
      "ends-with-hyphen-",
      "has--consecutive",
      "has spaces",
      "has/slashes",
      "a".repeat(40), // too long
    ];
    for (const bad of cases) {
      const r = validateConfig({
        ...(validConfig() as object),
        github: { bot_username: bad, skip_authors: [] },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors.some((e) => e.path === "github.bot_username")).toBe(true);
      }
    }
  });

  test("tone longer than 10k chars is rejected", () => {
    const r = validateConfig(validConfig({ tone: "x".repeat(10_001) }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path === "review.tone")).toBe(true);
    }
  });

  test("max_approvals_per_hour must be positive and <= 1000", () => {
    const tooHigh = validateConfig(validConfig({ max_approvals_per_hour: 1001 }));
    expect(tooHigh.ok).toBe(false);
    const zero = validateConfig(validConfig({ max_approvals_per_hour: 0 }));
    expect(zero.ok).toBe(false);
    const neg = validateConfig(validConfig({ max_approvals_per_hour: -5 }));
    expect(neg.ok).toBe(false);
  });

  test("concurrency must be 1..4", () => {
    expect(validateConfig(validConfig({ concurrency: 0 })).ok).toBe(false);
    expect(validateConfig(validConfig({ concurrency: 5 })).ok).toBe(false);
    expect(validateConfig(validConfig({ concurrency: 2 })).ok).toBe(true);
  });

  test("include_paths rejects empty-string patterns", () => {
    const r = validateConfig(validConfig({ include_paths: [""] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.startsWith("review.include_paths"))).toBe(true);
    }
  });

  test("exclude_paths caps entry length and list length", () => {
    const longPat = "x".repeat(501);
    expect(validateConfig(validConfig({ exclude_paths: [longPat] })).ok).toBe(false);
    const tooMany = Array.from({ length: 201 }, (_, i) => `p${i}`);
    expect(validateConfig(validConfig({ exclude_paths: tooMany })).ok).toBe(false);
  });

  test("error objects carry a readable dotted path", () => {
    const r = validateConfig(validConfig({ concurrency: 99 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const match = r.errors.find((e) => e.path === "review.concurrency");
      expect(match).toBeDefined();
      expect(typeof match!.message).toBe("string");
      expect(match!.message.length).toBeGreaterThan(0);
    }
  });
});
