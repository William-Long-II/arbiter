import { describe, expect, test } from "bun:test";
import { isSameOrigin } from "../src/web/server.ts";

function req(targetUrl: string, headers: Record<string, string> = {}): {
  r: Request;
  url: URL;
} {
  const r = new Request(targetUrl, { method: "POST", headers });
  return { r, url: new URL(r.url) };
}

describe("isSameOrigin", () => {
  test("no Origin or Referer is allowed (non-browser client)", () => {
    const { r, url } = req("http://127.0.0.1:8787/config/general");
    expect(isSameOrigin(r, url)).toBe(true);
  });

  test("matching Origin allowed", () => {
    const { r, url } = req("http://127.0.0.1:8787/config/general", {
      origin: "http://127.0.0.1:8787",
    });
    expect(isSameOrigin(r, url)).toBe(true);
  });

  test("different host rejected", () => {
    const { r, url } = req("http://127.0.0.1:8787/config/general", {
      origin: "https://evil.example",
    });
    expect(isSameOrigin(r, url)).toBe(false);
  });

  test("different scheme rejected", () => {
    const { r, url } = req("http://127.0.0.1:8787/config/general", {
      origin: "https://127.0.0.1:8787",
    });
    expect(isSameOrigin(r, url)).toBe(false);
  });

  test("Referer is accepted when Origin absent", () => {
    const { r, url } = req("http://127.0.0.1:8787/config/general", {
      referer: "http://127.0.0.1:8787/config",
    });
    expect(isSameOrigin(r, url)).toBe(true);
  });

  test("malformed Origin rejected", () => {
    const { r, url } = req("http://127.0.0.1:8787/config/general", {
      origin: "not a url",
    });
    expect(isSameOrigin(r, url)).toBe(false);
  });

  test("container bound to 0.0.0.0 still accepts browser Origin for 127.0.0.1", () => {
    // This is the real bug: inside Docker we bind to 0.0.0.0 but the browser
    // hits us on http://127.0.0.1:8787. The request's Host header is
    // 127.0.0.1:8787 (which is what matters), NOT 0.0.0.0:8787.
    const { r, url } = req("http://127.0.0.1:8787/config/general", {
      origin: "http://127.0.0.1:8787",
    });
    expect(isSameOrigin(r, url)).toBe(true);
  });

  test("port mismatch rejected", () => {
    const { r, url } = req("http://127.0.0.1:8787/config/general", {
      origin: "http://127.0.0.1:9999",
    });
    expect(isSameOrigin(r, url)).toBe(false);
  });
});
