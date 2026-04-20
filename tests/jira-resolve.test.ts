import { describe, expect, test } from "bun:test";
import { resolveIntent } from "../src/jira";

const CREDS = {
  baseUrl: "https://example.atlassian.net",
  email: "me@example.com",
  apiToken: "token",
};

function mockFetch(responder: (url: string) => Response): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    return responder(url);
  }) as typeof fetch;
}

describe("resolveIntent", () => {
  test("falls back when no ticket key found", async () => {
    const intent = await resolveIntent({
      prTitle: "some fix",
      prBody: "body text",
      branch: "fix",
    });
    expect(intent.source).toBe("pr-body");
    expect(intent.ticketKey).toBeUndefined();
    expect(intent.title).toBe("some fix");
    expect(intent.description).toBe("body text");
    expect(intent.warnings[0]).toMatch(/no jira ticket key/);
  });

  test("falls back when ticket key found but no creds configured", async () => {
    const intent = await resolveIntent({
      prTitle: "PROJ-1: thing",
      prBody: "",
      branch: "feat",
    });
    expect(intent.source).toBe("pr-body");
    expect(intent.ticketKey).toBe("PROJ-1");
    expect(intent.warnings[0]).toMatch(/credentials are not configured/);
  });

  test("fetches jira issue and returns source=jira on success", async () => {
    const fetchImpl = mockFetch((url) => {
      expect(url).toContain("/rest/api/3/issue/PROJ-7");
      return new Response(
        JSON.stringify({
          key: "PROJ-7",
          fields: {
            summary: "Fix the widget",
            description: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "AC: widget works" }],
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const intent = await resolveIntent(
      {
        prTitle: "PROJ-7 widget",
        prBody: "",
        branch: "feat/widget",
        creds: CREDS,
      },
      fetchImpl,
    );

    expect(intent.source).toBe("jira");
    expect(intent.ticketKey).toBe("PROJ-7");
    expect(intent.title).toBe("Fix the widget");
    expect(intent.description).toContain("AC: widget works");
    expect(intent.warnings).toEqual([]);
  });

  test("falls back with warning on jira fetch failure", async () => {
    const fetchImpl = mockFetch(
      () => new Response("not found", { status: 404, statusText: "Not Found" }),
    );
    const intent = await resolveIntent(
      {
        prTitle: "PROJ-9 thing",
        prBody: "pr body",
        branch: "",
        creds: CREDS,
      },
      fetchImpl,
    );
    expect(intent.source).toBe("pr-body");
    expect(intent.ticketKey).toBe("PROJ-9");
    expect(intent.title).toBe("PROJ-9 thing");
    expect(intent.description).toBe("pr body");
    expect(intent.warnings[0]).toMatch(/jira fetch failed for PROJ-9/);
  });
});
