import { describe, expect, test } from "bun:test";
import { buildAuthorizeUrl } from "../src/auth/oauth.ts";

describe("buildAuthorizeUrl", () => {
  test("includes client_id, redirect_uri, state, and default scope", () => {
    const url = buildAuthorizeUrl({
      clientId: "Iv23abc",
      redirectUri: "https://example.com/auth/github/callback",
      state: "nonce123",
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://github.com");
    expect(parsed.pathname).toBe("/login/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("Iv23abc");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://example.com/auth/github/callback",
    );
    expect(parsed.searchParams.get("state")).toBe("nonce123");
    expect(parsed.searchParams.get("scope")).toBe("read:user");
    expect(parsed.searchParams.get("allow_signup")).toBe("false");
  });

  test("custom scope is honored", () => {
    const url = buildAuthorizeUrl({
      clientId: "x",
      redirectUri: "http://localhost/cb",
      state: "s",
      scope: "read:user user:email",
    });
    expect(new URL(url).searchParams.get("scope")).toBe("read:user user:email");
  });

  test("URL-encodes special characters in redirect_uri", () => {
    const url = buildAuthorizeUrl({
      clientId: "x",
      redirectUri: "https://example.com/cb?foo=bar&baz=qux",
      state: "s",
    });
    // URLSearchParams handles encoding; the raw URL should contain the
    // encoded form, not the literal ampersand.
    expect(url).toContain("redirect_uri=https%3A%2F%2Fexample.com%2Fcb%3Ffoo%3Dbar%26baz%3Dqux");
  });
});
