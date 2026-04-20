import { describe, expect, test } from "bun:test";
import { GitHubIssueProvider, type IssueClient } from "../../src/jira/providers/github-issue";

function makeOctokit(
  issue: { number: number; title: string; body: string | null; html_url: string },
): IssueClient {
  return {
    issues: {
      get: async () => ({ data: issue }),
    },
  };
}

const SAMPLE_ISSUE = {
  number: 123,
  title: "Add dark mode",
  body: "Users should be able to toggle dark mode.",
  html_url: "https://github.com/owner/repo/issues/123",
};

describe("GitHubIssueProvider.match", () => {
  const octokit = makeOctokit(SAMPLE_ISSUE);
  const provider = new GitHubIssueProvider(octokit);
  const repoCtx = { repoOwner: "owner", repoName: "repo" };

  test("matches 'Fixes #N' in title", () => {
    const ref = provider.match({ title: "Fixes #123", body: "", ...repoCtx });
    expect(ref).not.toBeNull();
    expect(ref!.key).toBe("owner/repo#123");
  });

  test("matches 'Closes #N' in body", () => {
    const ref = provider.match({ title: "some change", body: "Closes #123", ...repoCtx });
    expect(ref).not.toBeNull();
    expect(ref!.key).toBe("owner/repo#123");
  });

  test("matches 'Resolves #N'", () => {
    const ref = provider.match({ title: "Resolves #123", body: "", ...repoCtx });
    expect(ref).not.toBeNull();
    expect(ref!.key).toBe("owner/repo#123");
  });

  test("matches 'Fixes org/repo#N' cross-repo reference", () => {
    const ref = provider.match({ title: "Fixes other/lib#456", body: "", ...repoCtx });
    expect(ref).not.toBeNull();
    expect(ref!.key).toBe("other/lib#456");
  });

  test("is case-insensitive (fixes vs FIXES)", () => {
    const ref = provider.match({ title: "FIXES #123", body: "", ...repoCtx });
    expect(ref).not.toBeNull();
  });

  test("is case-insensitive (CLOSES)", () => {
    const ref = provider.match({ title: "CLOSES #123", body: "", ...repoCtx });
    expect(ref).not.toBeNull();
  });

  test("is case-insensitive (RESOLVES)", () => {
    const ref = provider.match({ title: "RESOLVES #123", body: "", ...repoCtx });
    expect(ref).not.toBeNull();
  });

  test("returns null when no closing keyword found", () => {
    const ref = provider.match({ title: "refactor widget", body: "no keywords", ...repoCtx });
    expect(ref).toBeNull();
  });

  test("returns null when bare #N with no repo context", () => {
    const ref = provider.match({ title: "Fixes #123", body: "" });
    expect(ref).toBeNull();
  });
});

describe("GitHubIssueProvider.fetch", () => {
  test("fetches issue and returns Intent with source=github-issue", async () => {
    const octokit = makeOctokit(SAMPLE_ISSUE);
    const provider = new GitHubIssueProvider(octokit);
    const ref = {
      providerId: "github-issue",
      key: "owner/repo#123",
      raw: { owner: "owner", repo: "repo", number: 123 },
    };
    const intent = await provider.fetch(ref);

    expect(intent.source).toBe("github-issue");
    expect(intent.ticketKey).toBe("#123");
    expect(intent.title).toBe("Add dark mode");
    expect(intent.description).toBe("Users should be able to toggle dark mode.");
    expect(intent.warnings).toEqual([]);
  });

  test("handles null issue body gracefully", async () => {
    const octokit = makeOctokit({ ...SAMPLE_ISSUE, body: null });
    const provider = new GitHubIssueProvider(octokit);
    const ref = {
      providerId: "github-issue",
      key: "owner/repo#123",
      raw: { owner: "owner", repo: "repo", number: 123 },
    };
    const intent = await provider.fetch(ref);
    expect(intent.description).toBe("");
  });
});
