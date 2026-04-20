import { describe, expect, test } from "bun:test";
import { JiraProvider } from "../../src/jira/providers/jira";

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

describe("JiraProvider", () => {
  test("match returns null when no Jira key found", () => {
    const provider = new JiraProvider(CREDS);
    expect(provider.match({ title: "fix stuff", body: "no key here" })).toBeNull();
  });

  test("match extracts key from title", () => {
    const provider = new JiraProvider(CREDS);
    const ref = provider.match({ title: "PROJ-42: fix widget", body: "" });
    expect(ref).not.toBeNull();
    expect(ref!.key).toBe("PROJ-42");
    expect(ref!.providerId).toBe("jira");
  });

  test("match extracts key from body when not in title", () => {
    const provider = new JiraProvider(CREDS);
    const ref = provider.match({ title: "fix widget", body: "relates to TEAM-7" });
    expect(ref).not.toBeNull();
    expect(ref!.key).toBe("TEAM-7");
  });

  test("match extracts key from branch name (case-insensitive)", () => {
    const provider = new JiraProvider(CREDS);
    const ref = provider.match({ title: "fix widget", body: "", branch: "feature/proj-99-some-thing" });
    expect(ref).not.toBeNull();
    expect(ref!.key).toBe("PROJ-99");
  });

  test("fetch calls Jira REST API and returns Intent", async () => {
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

    const provider = new JiraProvider(CREDS, fetchImpl);
    const ref = { providerId: "jira", key: "PROJ-7", raw: { key: "PROJ-7" } };
    const intent = await provider.fetch(ref);

    expect(intent.source).toBe("jira");
    expect(intent.ticketKey).toBe("PROJ-7");
    expect(intent.title).toBe("Fix the widget");
    expect(intent.description).toContain("AC: widget works");
    expect(intent.warnings).toEqual([]);
  });

  test("fetch throws JiraFetchError on non-OK response", async () => {
    const fetchImpl = mockFetch(
      () => new Response("not found", { status: 404, statusText: "Not Found" }),
    );
    const provider = new JiraProvider(CREDS, fetchImpl);
    const ref = { providerId: "jira", key: "PROJ-9", raw: { key: "PROJ-9" } };
    await expect(provider.fetch(ref)).rejects.toThrow(/jira fetch failed/);
  });
});
