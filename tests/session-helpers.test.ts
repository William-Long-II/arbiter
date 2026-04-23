import { describe, expect, test } from "bun:test";
import {
  constantTimeEqual,
  expiredCookie,
  hashSessionToken,
  mintSessionToken,
  parseCookies,
  sessionCookie,
} from "../src/auth/session.ts";

describe("mintSessionToken", () => {
  test("returns a URL-safe base64 string with 256 bits of entropy (~43 chars)", () => {
    const a = mintSessionToken();
    const b = mintSessionToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("hashSessionToken", () => {
  test("is deterministic, 64-char hex", () => {
    const h1 = hashSessionToken("abc");
    const h2 = hashSessionToken("abc");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different inputs → different hashes", () => {
    expect(hashSessionToken("a")).not.toBe(hashSessionToken("b"));
  });
});

describe("sessionCookie", () => {
  test("includes HttpOnly, SameSite=Lax, Path=/, Max-Age by default", () => {
    const c = sessionCookie({ name: "x", value: "v", maxAgeSeconds: 60, secure: false });
    expect(c).toContain("x=v");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("Max-Age=60");
    expect(c).not.toContain("Secure");
  });

  test("sets Secure flag when requested (HTTPS deployments)", () => {
    const c = sessionCookie({ name: "x", value: "v", maxAgeSeconds: 60, secure: true });
    expect(c).toContain("Secure");
  });

  test("expiredCookie has Max-Age=0 and empty value", () => {
    const c = expiredCookie("x", false);
    expect(c).toContain("x=;");
    expect(c).toContain("Max-Age=0");
  });
});

describe("parseCookies", () => {
  test("returns {} for null/empty header", () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });

  test("splits on ; and trims whitespace", () => {
    expect(parseCookies("a=1; b=two ;c= three ")).toEqual({ a: "1", b: "two", c: "three" });
  });

  test("ignores malformed segments without =", () => {
    expect(parseCookies("a=1; stray; b=2")).toEqual({ a: "1", b: "2" });
  });

  test("decodes URL-encoded values", () => {
    expect(parseCookies("x=%3Chello%3E")).toEqual({ x: "<hello>" });
  });
});

describe("constantTimeEqual", () => {
  test("equal strings → true", () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
  });

  test("different strings of same length → false", () => {
    expect(constantTimeEqual("abcd", "abce")).toBe(false);
  });

  test("different lengths → false (does not throw)", () => {
    expect(constantTimeEqual("short", "longer string")).toBe(false);
  });
});
