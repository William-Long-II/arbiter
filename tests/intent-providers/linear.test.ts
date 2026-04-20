import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { LinearProvider } from "../../src/jira/providers/linear";

function mockFetch(responder: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return responder(url, init);
  }) as typeof fetch;
}

const SAMPLE_RESPONSE = {
  data: {
    issue: {
      identifier: "ENG-42",
      title: "Implement OAuth flow",
      description: "Add OAuth 2.0 support with PKCE.",
      url: "https://linear.app/team/issue/ENG-42",
    },
  },
};

describe("LinearProvider.match", () => {
  const provider = new LinearProvider("lin_api_testkey");

  test("matches Linear-style key in title", () => {
    const ref = provider.match({ title: "ENG-42: add oauth", body: "" });
    expect(ref).not.toBeNull();
    expect(ref!.key).toBe("ENG-42");
    expect(ref!.providerId).toBe("linear");
  });

  test("matches key in body when not in title", () => {
    const ref = provider.match({ title: "fix auth", body: "related to ENG-42" });
    expect(ref).not.toBeNull();
    expect(ref!.key).toBe("ENG-42");
  });

  test("returns null when no matching key", () => {
    const ref = provider.match({ title: "fix stuff", body: "no key here" });
    expect(ref).toBeNull();
  });
});

describe("LinearProvider.fetch", () => {
  test("calls Linear GraphQL and returns Intent with source=linear", async () => {
    const fetchImpl = mockFetch((_url, init) => {
      // Verify it sends to the Linear endpoint
      expect(_url).toBe("https://api.linear.app/graphql");
      const body = JSON.parse(init?.body as string);
      expect(body.variables.id).toBe("ENG-42");
      return new Response(JSON.stringify(SAMPLE_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const provider = new LinearProvider("lin_api_testkey", fetchImpl);
    const ref = { providerId: "linear", key: "ENG-42", raw: { key: "ENG-42" } };
    const intent = await provider.fetch(ref);

    expect(intent.source).toBe("linear");
    expect(intent.ticketKey).toBe("ENG-42");
    expect(intent.title).toBe("Implement OAuth flow");
    expect(intent.description).toBe("Add OAuth 2.0 support with PKCE.");
    expect(intent.warnings).toEqual([]);
  });

  test("throws on HTTP error", async () => {
    const fetchImpl = mockFetch(
      () => new Response("unauthorized", { status: 401, statusText: "Unauthorized" }),
    );
    const provider = new LinearProvider("bad_key", fetchImpl);
    const ref = { providerId: "linear", key: "ENG-42", raw: { key: "ENG-42" } };
    await expect(provider.fetch(ref)).rejects.toThrow(/Linear GraphQL request failed/);
  });

  test("throws on GraphQL errors in response body", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(
        JSON.stringify({ errors: [{ message: "Issue not found" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new LinearProvider("lin_api_testkey", fetchImpl);
    const ref = { providerId: "linear", key: "ENG-99", raw: { key: "ENG-99" } };
    await expect(provider.fetch(ref)).rejects.toThrow(/Linear GraphQL error/);
  });

  test("throws when issue not found in response data", async () => {
    const fetchImpl = mockFetch(() =>
      new Response(
        JSON.stringify({ data: { issue: null } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new LinearProvider("lin_api_testkey", fetchImpl);
    const ref = { providerId: "linear", key: "ENG-99", raw: { key: "ENG-99" } };
    await expect(provider.fetch(ref)).rejects.toThrow(/not found/);
  });
});

describe("LinearProvider no-op when LINEAR_API_KEY unset", () => {
  const originalKey = process.env.LINEAR_API_KEY;

  beforeEach(() => {
    delete process.env.LINEAR_API_KEY;
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.LINEAR_API_KEY = originalKey;
    }
  });

  test("buildLinearProvider returns null when LINEAR_API_KEY is unset", async () => {
    // Dynamically import to pick up env change in this test
    const { buildLinearProvider } = await import("../../src/jira/providers/linear");
    const provider = buildLinearProvider();
    expect(provider).toBeNull();
  });
});
