import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { extractLinearRefs, fetchLinearTicket } from "../src/intent/linear.ts";
import type { IntentCredentials } from "../src/state/db.ts";
import type { TicketRef } from "../src/intent/types.ts";

const CREDS: IntentCredentials = {
  org_name: "acme",
  kind: "linear",
  host: null,
  email: null,
  api_token: "lin_api_test_token",
  created_at: "2026-04-23T00:00:00Z",
  updated_at: "2026-04-23T00:00:00Z",
};

describe("extractLinearRefs", () => {
  test("captures standard identifiers", () => {
    const refs = extractLinearRefs({
      title: "Fix ENG-123 and address OPS-456",
      body: "See DESIGN-7.",
    });
    expect(refs.map((r) => r.key).sort()).toEqual(["DESIGN-7", "ENG-123", "OPS-456"]);
    for (const r of refs) expect(r.kind).toBe("linear");
  });

  test("single-letter project is NOT matched", () => {
    const refs = extractLinearRefs({ title: "A-1", body: "" });
    expect(refs).toEqual([]);
  });

  test("lowercase does not match", () => {
    expect(extractLinearRefs({ title: "eng-1", body: "" })).toEqual([]);
  });

  test("dedup", () => {
    const refs = extractLinearRefs({ title: "ENG-1 ENG-1", body: "ENG-1" });
    expect(refs).toHaveLength(1);
  });

  test("scans title and body", () => {
    const refs = extractLinearRefs({ title: "ENG-1", body: "OPS-2" });
    expect(refs.map((r) => r.key).sort()).toEqual(["ENG-1", "OPS-2"]);
  });
});

describe("fetchLinearTicket", () => {
  const originalFetch = globalThis.fetch;
  let seen: { url: string; init: RequestInit }[] = [];

  beforeEach(() => {
    seen = [];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(response: unknown, status = 200) {
    globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify(response), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  }

  const ref: TicketRef = { kind: "linear", key: "ENG-42", raw: "ENG-42" };

  test("returns null if api_token is missing", async () => {
    const r = await fetchLinearTicket({ ...CREDS, api_token: null }, ref);
    expect(r).toBeNull();
  });

  test("sends the GraphQL query with Authorization header (no Bearer prefix)", async () => {
    mockFetch({
      data: {
        issue: {
          identifier: "ENG-42",
          title: "Leaky pool",
          description: "pool doesn't drain on SIGTERM",
          url: "https://linear.app/acme/issue/ENG-42/leaky-pool",
        },
      },
    });
    const result = await fetchLinearTicket(CREDS, ref);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("linear");
    expect(result!.title).toBe("Leaky pool");
    expect(result!.body).toBe("pool doesn't drain on SIGTERM");
    expect(result!.url).toContain("linear.app");
    // Verify the request shape.
    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(call.url).toBe("https://api.linear.app/graphql");
    expect((call.init.headers as Record<string, string>).authorization).toBe("lin_api_test_token");
    const body = JSON.parse(String(call.init.body));
    expect(body.variables).toEqual({ id: "ENG-42" });
    expect(body.query).toContain("issue(id: $id)");
  });

  test("null when the API returns no issue", async () => {
    mockFetch({ data: { issue: null } });
    expect(await fetchLinearTicket(CREDS, ref)).toBeNull();
  });

  test("null on non-2xx", async () => {
    mockFetch({ errors: "unauthorized" }, 401);
    expect(await fetchLinearTicket(CREDS, ref)).toBeNull();
  });

  test("null on thrown fetch (timeout, network, etc)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof globalThis.fetch;
    expect(await fetchLinearTicket(CREDS, ref)).toBeNull();
  });

  test("falls back to a synthesized url when response omits it", async () => {
    mockFetch({
      data: {
        issue: {
          identifier: "ENG-42",
          title: "Leaky pool",
          description: null,
        },
      },
    });
    const r = await fetchLinearTicket(CREDS, ref);
    expect(r!.url).toContain("linear.app");
    expect(r!.body).toBe(""); // null description → empty
  });

  test("rejects non-linear refs defensively", async () => {
    const gh: TicketRef = { kind: "github-issue", key: "a/b#1", raw: "#1" };
    expect(await fetchLinearTicket(CREDS, gh)).toBeNull();
  });
});
