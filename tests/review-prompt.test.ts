import { describe, expect, test } from "bun:test";
import type { PullRequestDiff } from "../src/github";
import type { Intent } from "../src/jira";
import type { ConventionsResult } from "../src/review/conventions";
import { buildUserMessage } from "../src/review/prompt";
import { filterDiff, OMITTED_FILES_SENTINEL } from "../src/review/diff-filter";
import type { CoverageDelta } from "../src/review/coverage-delta";
import type { Heuristic } from "../src/review/heuristics/index";

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

  test("REPO_CONVENTIONS section included verbatim when conventions are present", () => {
    const conventions: ConventionsResult = {
      sections: [
        { path: "CLAUDE.md", content: "Use TypeScript strict mode.", truncated: false },
        { path: "CONTRIBUTING.md", content: "Run bun test before committing.", truncated: false },
      ],
      totalBytes: 60,
    };
    const out = buildUserMessage({ intent: makeIntent(), diff: makeDiff(), conventions });
    expect(out).toContain("## Repo conventions");
    expect(out).toContain(
      "The target repo ships these contributor docs. Calibrate your review to them where relevant.",
    );
    expect(out).toContain("### CLAUDE.md");
    expect(out).toContain("Use TypeScript strict mode.");
    expect(out).toContain("### CONTRIBUTING.md");
    expect(out).toContain("Run bun test before committing.");
  });

  test("REPO_CONVENTIONS section omitted cleanly when sections is empty", () => {
    const conventions: ConventionsResult = { sections: [], totalBytes: 0 };
    const out = buildUserMessage({ intent: makeIntent(), diff: makeDiff(), conventions });
    expect(out).not.toContain("## Repo conventions");
    expect(out).not.toContain("Calibrate your review");
  });

  test("REPO_CONVENTIONS section omitted when conventions parameter is absent", () => {
    const out = buildUserMessage({ intent: makeIntent(), diff: makeDiff() });
    expect(out).not.toContain("## Repo conventions");
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

// ─── Prompt golden tests: Test coverage signal block ─────────────────────────

describe("buildUserMessage — Test coverage signal golden", () => {
  const srcDelta: CoverageDelta = {
    addedSrcLines: 120,
    addedTestLines: 0,
    ratio: 0,
    flaggedSymbols: [
      { file: "src/widgets/factory.ts", symbol: "createWidget" },
      { file: "src/widgets/factory.ts", symbol: "validateWidget" },
    ],
  };

  test("coverage signal block present when addedSrcLines > 0", () => {
    const out = buildUserMessage({
      intent: makeIntent(),
      diff: makeDiff(),
      coverageDelta: srcDelta,
    });
    expect(out).toContain("## Test coverage signal");
    expect(out).toContain("added_source_lines: 120");
    expect(out).toContain("added_test_lines: 0");
    expect(out).toContain(
      "- src/widgets/factory.ts :: createWidget",
    );
    expect(out).toContain(
      "- src/widgets/factory.ts :: validateWidget",
    );
  });

  test("coverage signal block appears before ## Diff", () => {
    const out = buildUserMessage({
      intent: makeIntent(),
      diff: makeDiff(),
      coverageDelta: srcDelta,
    });
    const signalPos = out.indexOf("## Test coverage signal");
    const diffPos = out.indexOf("## Diff");
    expect(signalPos).toBeGreaterThanOrEqual(0);
    expect(signalPos).toBeLessThan(diffPos);
  });

  test("coverage signal block absent when addedSrcLines === 0", () => {
    const zeroDelta: CoverageDelta = {
      addedSrcLines: 0,
      addedTestLines: 0,
      ratio: 0,
      flaggedSymbols: [],
    };
    const out = buildUserMessage({
      intent: makeIntent(),
      diff: makeDiff(),
      coverageDelta: zeroDelta,
    });
    expect(out).not.toContain("## Test coverage signal");
  });

  test("coverage signal block absent when coverageDelta not provided", () => {
    const out = buildUserMessage({
      intent: makeIntent(),
      diff: makeDiff(),
    });
    expect(out).not.toContain("## Test coverage signal");
  });

  test("shows 'untested_new_symbols: none' when flaggedSymbols is empty but src lines > 0", () => {
    const hasTestsDelta: CoverageDelta = {
      addedSrcLines: 50,
      addedTestLines: 30,
      ratio: 0.6,
      flaggedSymbols: [],
    };
    const out = buildUserMessage({
      intent: makeIntent(),
      diff: makeDiff(),
      coverageDelta: hasTestsDelta,
    });
    expect(out).toContain("## Test coverage signal");
    expect(out).toContain("added_source_lines: 50");
    expect(out).toContain("added_test_lines: 30");
    expect(out).toContain("untested_new_symbols: none");
  });
});

// ─── Prompt golden tests: Language hints block ───────────────────────────────

describe("buildUserMessage — Language hints golden", () => {
  const tsHint: Heuristic = {
    id: "ts/unhandled-promise",
    summary: "Unhandled promise rejection",
    hint: "Check for floating promises.",
  };

  const pyHint: Heuristic = {
    id: "py/mutable-default-arg",
    summary: "Mutable default argument",
    hint: "Watch for mutable defaults.",
  };

  test("## Language hints section present when heuristics non-empty", () => {
    const out = buildUserMessage({
      intent: makeIntent(),
      diff: makeDiff(),
      heuristics: [tsHint],
    });
    expect(out).toContain("## Language hints");
    expect(out).toContain("Unhandled promise rejection");
    expect(out).toContain("Check for floating promises.");
  });

  test("## Language hints section appears before ## Diff", () => {
    const out = buildUserMessage({
      intent: makeIntent(),
      diff: makeDiff(),
      heuristics: [tsHint],
    });
    const hintsPos = out.indexOf("## Language hints");
    const diffPos = out.indexOf("## Diff");
    expect(hintsPos).toBeGreaterThanOrEqual(0);
    expect(hintsPos).toBeLessThan(diffPos);
  });

  test("mixed-language PR golden: .ts and .py hints both rendered", () => {
    const out = buildUserMessage({
      intent: makeIntent(),
      diff: makeDiff(),
      heuristics: [tsHint, pyHint],
    });
    expect(out).toContain("## Language hints");
    // TypeScript hint rendered
    expect(out).toContain("Unhandled promise rejection");
    // Python hint rendered
    expect(out).toContain("Mutable default argument");
    // Both appear before ## Diff
    const hintsPos = out.indexOf("## Language hints");
    const diffPos = out.indexOf("## Diff");
    expect(hintsPos).toBeLessThan(diffPos);
  });

  test("## Language hints section absent when heuristics is empty array", () => {
    const out = buildUserMessage({
      intent: makeIntent(),
      diff: makeDiff(),
      heuristics: [],
    });
    expect(out).not.toContain("## Language hints");
  });

  test("## Language hints section absent when heuristics not provided", () => {
    const out = buildUserMessage({
      intent: makeIntent(),
      diff: makeDiff(),
    });
    expect(out).not.toContain("## Language hints");
  });

  test("hint bullets are formatted as bold-label markdown", () => {
    const out = buildUserMessage({
      intent: makeIntent(),
      diff: makeDiff(),
      heuristics: [tsHint],
    });
    expect(out).toContain("- **Unhandled promise rejection**:");
  });

  test("prompt instructs LLM not to comment if pattern is absent", () => {
    const out = buildUserMessage({
      intent: makeIntent(),
      diff: makeDiff(),
      heuristics: [tsHint],
    });
    expect(out).toContain("Do not comment if they are not present.");
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
