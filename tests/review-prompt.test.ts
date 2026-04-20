import { describe, expect, test } from "bun:test";
import type { PullRequestDiff } from "../src/github";
import type { Intent } from "../src/jira";
import { buildUserMessage } from "../src/review/prompt";

function makeDiff(overrides: Partial<PullRequestDiff> = {}): PullRequestDiff {
  return {
    owner: "acme",
    repo: "widget",
    number: 42,
    headSha: "abc",
    baseSha: "def",
    title: "Add widget factory",
    body: "implements PROJ-1",
    files: [
      {
        filename: "src/factory.ts",
        status: "added",
        additions: 10,
        deletions: 0,
        changes: 10,
        patch: "@@ -0,0 +1,10 @@\n+export function build() {}\n",
      },
    ],
    totals: { additions: 10, deletions: 0, changedFiles: 1 },
    ...overrides,
  };
}

function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    source: "jira",
    ticketKey: "PROJ-1",
    title: "Add a widget factory",
    description: "AC: we can call build() and get a widget.",
    warnings: [],
    ...overrides,
  };
}

describe("buildUserMessage", () => {
  test("includes intent source, ticket, title, description, and diff", () => {
    const out = buildUserMessage({ intent: makeIntent(), diff: makeDiff() });
    expect(out).toContain("Source: jira");
    expect(out).toContain("Ticket: PROJ-1");
    expect(out).toContain("AC: we can call build() and get a widget.");
    expect(out).toContain("acme/widget#42");
    expect(out).toContain("src/factory.ts");
    expect(out).toContain("+export function build() {}");
  });

  test("emits intent warnings section when warnings are present", () => {
    const out = buildUserMessage({
      intent: makeIntent({
        source: "pr-body",
        warnings: ["jira fetch failed for PROJ-1: 404"],
      }),
      diff: makeDiff(),
    });
    expect(out).toContain("### Intent warnings");
    expect(out).toContain("jira fetch failed for PROJ-1: 404");
  });

  test("handles files without patches (binary/renamed) gracefully", () => {
    const diff = makeDiff({
      files: [
        {
          filename: "logo.png",
          status: "modified",
          additions: 0,
          deletions: 0,
          changes: 0,
          patch: undefined,
        },
      ],
    });
    const out = buildUserMessage({ intent: makeIntent(), diff });
    expect(out).toContain("logo.png");
    expect(out).toContain("patch omitted");
  });

  test("notes renamed files", () => {
    const diff = makeDiff({
      files: [
        {
          filename: "src/new.ts",
          status: "renamed",
          additions: 1,
          deletions: 1,
          changes: 2,
          patch: "@@ -1 +1 @@\n-x\n+y\n",
          previous_filename: "src/old.ts",
        },
      ],
    });
    const out = buildUserMessage({ intent: makeIntent(), diff });
    expect(out).toContain("Renamed from: src/old.ts");
  });
});
