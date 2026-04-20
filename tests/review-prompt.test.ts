import { describe, expect, test } from "bun:test";
import type { PullRequestDiff } from "../src/github";
import type { Intent } from "../src/jira";
import { buildUserMessage } from "../src/review/prompt";
import { filterDiff, OMITTED_FILES_SENTINEL } from "../src/review/diff-filter";

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

// ─── Prompt golden tests: OMITTED_FILES block ────────────────────────────────

describe("buildUserMessage — OMITTED_FILES golden", () => {
  test("OMITTED_FILES block is present when filtering happened", () => {
    const diff = makeDiff({
      files: [
        {
          filename: "package-lock.json",
          status: "modified",
          additions: 100,
          deletions: 100,
          changes: 200,
          patch: "@@ -1 +1 @@\n+lock\n",
        },
        {
          filename: "src/factory.ts",
          status: "added",
          additions: 10,
          deletions: 0,
          changes: 10,
          patch: "@@ -0,0 +1,10 @@\n+export function build() {}\n",
        },
      ],
    });
    const filterResult = filterDiff(diff.files);
    const out = buildUserMessage({ intent: makeIntent(), diff, filterResult });

    // Sentinel must be present
    expect(out).toContain(OMITTED_FILES_SENTINEL);
    // Exact format: "- <path> (<reason>)"
    expect(out).toContain("- package-lock.json (lockfile)");
    // Lockfile must not appear in the diff section
    const diffSectionStart = out.indexOf("## Diff");
    const omittedSectionStart = out.indexOf(OMITTED_FILES_SENTINEL);
    // OMITTED_FILES block should appear before ## Diff
    expect(omittedSectionStart).toBeLessThan(diffSectionStart);
    // Kept file should still be in the diff
    expect(out).toContain("src/factory.ts");
  });

  test("OMITTED_FILES block is absent when no files are filtered", () => {
    const diff = makeDiff(); // default: only src/factory.ts
    const filterResult = filterDiff(diff.files);
    const out = buildUserMessage({ intent: makeIntent(), diff, filterResult });

    expect(out).not.toContain(OMITTED_FILES_SENTINEL);
    expect(out).toContain("src/factory.ts");
  });

  test("OMITTED_FILES block is absent when filterResult is not passed", () => {
    const out = buildUserMessage({ intent: makeIntent(), diff: makeDiff() });
    expect(out).not.toContain(OMITTED_FILES_SENTINEL);
  });
});
