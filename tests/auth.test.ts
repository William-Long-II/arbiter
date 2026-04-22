import { describe, expect, test } from "bun:test";
import { requireAuth } from "../src/web/auth.ts";

function reqWith(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/whatever", { headers });
}

function basic(user: string, pass: string): string {
  // Use Buffer so unicode passwords round-trip as UTF-8 bytes; btoa is Latin-1-only.
  return "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
}

describe("requireAuth", () => {
  test("disabled when password is empty string", () => {
    expect(requireAuth(reqWith(), "")).toBeNull();
    expect(requireAuth(reqWith({ authorization: basic("evil", "wrong") }), "")).toBeNull();
  });

  test("401 with WWW-Authenticate when no header", async () => {
    const res = requireAuth(reqWith(), "secret");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(res!.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
  });

  test("401 on wrong password", () => {
    const res = requireAuth(reqWith({ authorization: basic("admin", "wrong") }), "secret");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  test("401 on wrong username even with right password", () => {
    const res = requireAuth(reqWith({ authorization: basic("root", "secret") }), "secret");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  test("passes with admin + correct password", () => {
    expect(
      requireAuth(reqWith({ authorization: basic("admin", "secret") }), "secret"),
    ).toBeNull();
  });

  test("401 on malformed header", () => {
    expect(requireAuth(reqWith({ authorization: "Bearer xyz" }), "secret")).not.toBeNull();
    expect(requireAuth(reqWith({ authorization: "Basic not-base64-!!" }), "secret")).not.toBeNull();
    expect(requireAuth(reqWith({ authorization: "Basic " + btoa("no-colon") }), "secret")).not.toBeNull();
  });

  test("unicode passwords compare correctly", () => {
    expect(
      requireAuth(reqWith({ authorization: basic("admin", "pässw🔑rd") }), "pässw🔑rd"),
    ).toBeNull();
    expect(
      requireAuth(reqWith({ authorization: basic("admin", "password") }), "pässw🔑rd"),
    ).not.toBeNull();
  });
});
