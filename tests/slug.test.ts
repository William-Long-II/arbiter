import { describe, expect, test } from "bun:test";
import { formatSlug, parseSlug, sluggedPath } from "../src/github/slug.ts";

describe("parseSlug", () => {
  test("parses a well-formed slug", () => {
    expect(parseSlug("acme/widget")).toEqual({ owner: "acme", name: "widget" });
  });

  test("owner and name with dots, dashes, underscores", () => {
    expect(parseSlug("my-org/repo.with.dots_and-dashes")).toEqual({
      owner: "my-org",
      name: "repo.with.dots_and-dashes",
    });
  });

  test("rejects missing slash", () => {
    expect(parseSlug("acme")).toBeNull();
    expect(parseSlug("")).toBeNull();
  });

  test("rejects extra slashes (a//b, a/b/c, /a/b)", () => {
    expect(parseSlug("acme//widget")).toBeNull();
    expect(parseSlug("acme/widget/extra")).toBeNull();
    expect(parseSlug("/acme/widget")).toBeNull();
  });

  test("rejects empty owner or name", () => {
    expect(parseSlug("/widget")).toBeNull();
    expect(parseSlug("acme/")).toBeNull();
    expect(parseSlug("/")).toBeNull();
  });

  test("non-string input returns null defensively", () => {
    // Callers pass store-returned strings, but be defensive.
    expect(parseSlug(null as unknown as string)).toBeNull();
    expect(parseSlug(undefined as unknown as string)).toBeNull();
    expect(parseSlug(42 as unknown as string)).toBeNull();
  });
});

describe("formatSlug", () => {
  test("round-trips with parseSlug", () => {
    const s = "acme/widget";
    const parsed = parseSlug(s)!;
    expect(formatSlug(parsed)).toBe(s);
  });
});

describe("sluggedPath", () => {
  test("produces two separate encoded segments", () => {
    expect(sluggedPath("acme/widget")).toBe("acme/widget");
  });

  test("encodes special characters per-segment without collapsing the slash", () => {
    // A name like "my repo" needs the space encoded but the owner/name
    // boundary must remain a real "/" so the route matcher sees two segments.
    expect(sluggedPath("my-org/my repo")).toBe("my-org/my%20repo");
  });

  test("malformed slug returns empty string rather than a broken URL", () => {
    expect(sluggedPath("acme")).toBe("");
    expect(sluggedPath("acme/widget/extra")).toBe("");
    expect(sluggedPath("")).toBe("");
  });

  test("regression: the old encodeURIComponent-of-whole-slug form would have produced a %2F", () => {
    // This documents the exact mistake the helper prevents — see PR #109.
    const bad = encodeURIComponent("acme/widget");
    expect(bad).toBe("acme%2Fwidget");
    // sluggedPath must NOT produce that shape.
    expect(sluggedPath("acme/widget")).not.toContain("%2F");
  });
});
