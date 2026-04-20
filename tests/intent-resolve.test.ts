/**
 * Integration tests for the pluggable resolveIntent pipeline.
 *
 * These tests verify:
 * - Provider precedence follows INTENT_PROVIDERS order
 * - A failing provider falls through to the next
 * - All providers returning null falls back to PR-body
 * - Backward compatibility: Jira-only deployment behaves identically
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { resolveIntent } from "../src/jira";
import type { IssueClient } from "../src/jira/providers/github-issue";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const JIRA_CREDS = {
  baseUrl: "https://example.atlassian.net",
  email: "me@example.com",
  apiToken: "token",
};

function jiraFetch(key: string, opts?: { fail?: boolean }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (opts?.fail) {
      return new Response("server error", { status: 500, statusText: "Internal Server Error" });
    }
    if (url.includes(`/issue/${key}`)) {
      return new Response(
        JSON.stringify({
          key,
          fields: {
            summary: `Jira: ${key} summary`,
            description: null,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function makeOctokit(
  issue: { number: number; title: string; body: string | null; html_url: string },
): IssueClient {
  return {
    issues: {
      get: async () => ({ data: issue }),
    },
  };
}

const GITHUB_ISSUE = {
  number: 123,
  title: "GitHub issue title",
  body: "GitHub issue body",
  html_url: "https://github.com/owner/repo/issues/123",
};

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe("resolveIntent provider precedence", () => {
  const originalProviders = process.env.INTENT_PROVIDERS;

  afterEach(() => {
    if (originalProviders !== undefined) {
      process.env.INTENT_PROVIDERS = originalProviders;
    } else {
      delete process.env.INTENT_PROVIDERS;
    }
    delete process.env.LINEAR_API_KEY;
  });

  test("picks Jira first when INTENT_PROVIDERS=jira,github-issue and PR has both a Jira key and Fixes #123", async () => {
    process.env.INTENT_PROVIDERS = "jira,github-issue";

    const intent = await resolveIntent(
      {
        prTitle: "PROJ-1: fix stuff (Fixes #123)",
        prBody: "Fixes #123",
        branch: "",
        creds: JIRA_CREDS,
        octokit: makeOctokit(GITHUB_ISSUE),
        repoOwner: "owner",
        repoName: "repo",
      },
      jiraFetch("PROJ-1"),
    );

    expect(intent.source).toBe("jira");
    expect(intent.ticketKey).toBe("PROJ-1");
  });

  test("picks github-issue first when INTENT_PROVIDERS=github-issue,jira and PR has both", async () => {
    process.env.INTENT_PROVIDERS = "github-issue,jira";

    const intent = await resolveIntent(
      {
        prTitle: "PROJ-1: fix stuff (Fixes #123)",
        prBody: "Fixes #123",
        branch: "",
        creds: JIRA_CREDS,
        octokit: makeOctokit(GITHUB_ISSUE),
        repoOwner: "owner",
        repoName: "repo",
      },
      jiraFetch("PROJ-1"),
    );

    expect(intent.source).toBe("github-issue");
    expect(intent.ticketKey).toBe("#123");
  });

  test("falls through to github-issue when Jira fetch fails", async () => {
    process.env.INTENT_PROVIDERS = "jira,github-issue";

    const intent = await resolveIntent(
      {
        prTitle: "PROJ-1: fix stuff",
        prBody: "Fixes #123",
        branch: "",
        creds: JIRA_CREDS,
        octokit: makeOctokit(GITHUB_ISSUE),
        repoOwner: "owner",
        repoName: "repo",
      },
      jiraFetch("PROJ-1", { fail: true }),
    );

    expect(intent.source).toBe("github-issue");
    expect(intent.ticketKey).toBe("#123");
    // Warning recorded for the Jira failure
    expect(intent.warnings.some((w) => w.includes("jira fetch failed"))).toBe(true);
  });

  test("falls back to PR-body when all providers return null", async () => {
    process.env.INTENT_PROVIDERS = "jira,github-issue";

    const intent = await resolveIntent(
      {
        prTitle: "plain refactor",
        prBody: "no ticket keys anywhere",
        branch: "",
        creds: JIRA_CREDS,
        octokit: makeOctokit(GITHUB_ISSUE),
        repoOwner: "owner",
        repoName: "repo",
      },
      jiraFetch("PROJ-1"),
    );

    expect(intent.source).toBe("pr-body");
    expect(intent.title).toBe("plain refactor");
    expect(intent.description).toBe("no ticket keys anywhere");
  });

  test("empty INTENT_PROVIDERS results in PR-body fallback (no providers active)", async () => {
    process.env.INTENT_PROVIDERS = "";

    const intent = await resolveIntent({
      prTitle: "PROJ-1 some fix",
      prBody: "body text",
      branch: "",
      creds: JIRA_CREDS,
    });

    expect(intent.source).toBe("pr-body");
  });

  test("backward compat: existing Jira-only deployment (no INTENT_PROVIDERS env var) still fetches Jira", async () => {
    // Unset INTENT_PROVIDERS — defaults to jira,github-issue,linear
    delete process.env.INTENT_PROVIDERS;

    const intent = await resolveIntent(
      {
        prTitle: "PROJ-7 widget",
        prBody: "",
        branch: "feat/widget",
        creds: JIRA_CREDS,
      },
      jiraFetch("PROJ-7"),
    );

    expect(intent.source).toBe("jira");
    expect(intent.ticketKey).toBe("PROJ-7");
  });

  test("backward compat: no creds, no ticket key → pr-body fallback with no crash", async () => {
    delete process.env.INTENT_PROVIDERS;

    const intent = await resolveIntent({
      prTitle: "some fix",
      prBody: "body text",
      branch: "fix",
    });

    expect(intent.source).toBe("pr-body");
    expect(intent.title).toBe("some fix");
  });

  test("skips github-issue provider when octokit is not provided", async () => {
    process.env.INTENT_PROVIDERS = "github-issue,jira";

    const intent = await resolveIntent(
      {
        prTitle: "Fixes #123 and also PROJ-1",
        prBody: "",
        branch: "",
        creds: JIRA_CREDS,
        // No octokit provided
      },
      jiraFetch("PROJ-1"),
    );

    // github-issue provider is absent; jira provider resolves PROJ-1
    expect(intent.source).toBe("jira");
  });
});
