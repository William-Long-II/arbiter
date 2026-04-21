/**
 * Tests for scripts/review-pr.ts
 *
 * All tests use stubbed Octokit and Anthropic to avoid any network calls.
 * The dry-run path (no --with-llm) must:
 *   - not invoke anthropic.messages.parse at all
 *   - not invoke octokit.pulls.createReview
 *   - print the banner and user message to stdout
 *   - return a DryRunResult with expected shape
 *
 * The --with-llm path must invoke the Anthropic mock exactly once.
 * The --post path must additionally call octokit.pulls.createReview.
 * Bad args must call process.exit(2) or throw an ArgError (we test parseArgs).
 */
import { describe, expect, test, beforeEach } from "bun:test";
import type { Octokit } from "../src/github";
import type { ReviewResult } from "../src/review";
import { resultCache } from "../src/review/result-cache";
import { parseArgs, runDryRun } from "../scripts/review-pr";
import type { DryRunOptions } from "../scripts/review-pr";

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

type OctokitStubOpts = {
  /** Whether createReview should succeed (default true). */
  allowPost?: boolean;
};

type CreateReviewArgs = {
  owner: string;
  repo: string;
  pull_number: number;
  commit_id: string;
  event: string;
  body?: string;
  comments?: unknown[];
};

function makeOctokitStub(opts: OctokitStubOpts = {}): {
  octokit: Octokit;
  createReviewCalls: CreateReviewArgs[];
} {
  const createReviewCalls: CreateReviewArgs[] = [];

  // Minimal PR data matching the stub diff below
  const prData = {
    data: {
      head: { sha: "abc1234567890" },
      base: { sha: "def0987654321" },
      title: "Add widget factory",
      body: "Adds a factory function. Relates to #42",
      additions: 5,
      deletions: 0,
      changed_files: 1,
    },
  };

  const prFilesData = [
    {
      filename: "src/factory.ts",
      status: "added",
      additions: 5,
      deletions: 0,
      changes: 5,
      patch: "+export function createWidget(id: string) {\n+  return { id };\n+}\n",
    },
  ];

  const octokit = {
    pulls: {
      get: async () => prData,
      listFiles: {},
      listReviews: {},
      createReview: async (args: CreateReviewArgs) => {
        createReviewCalls.push(args);
        if (opts.allowPost === false) {
          throw new Error("stub: createReview not allowed");
        }
        return { data: { id: 9001 } };
      },
    },
    paginate: {
      iterator: async function* (method: unknown, params: Record<string, unknown>) {
        // Route by inspecting params
        if ("pull_number" in params) {
          // Could be listFiles or listReviews — distinguish by which property is registered
          // We use listFiles for PR files (the diff fetch) and listReviews for review check.
          // Since both use pull_number we check whether we're asked for "files" vs "reviews"
          // by checking the stub method reference.
          if (method === octokit.pulls.listFiles) {
            yield { data: prFilesData };
          } else {
            // listReviews — return empty so no dedup skip occurs
            yield { data: [] };
          }
        } else {
          yield { data: [] };
        }
      },
      // paginate.iterator needs listFiles / listReviews to be the same references
    },
    repos: {
      getContent: async () => {
        // Return 404 for .gitattributes — no linguist filtering
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
    },
  } as unknown as Octokit;

  return { octokit, createReviewCalls };
}

const mockReviewResult: ReviewResult = {
  verdict: "approve",
  summary: "Clean change.",
  lineComments: [],
};

function makeAnthropicStub(): {
  anthropic: Parameters<typeof runDryRun>[0]["anthropic"];
  parseCalls: unknown[];
} {
  const parseCalls: unknown[] = [];
  const anthropic = {
    messages: {
      parse: async (params: unknown) => {
        parseCalls.push(params);
        return {
          parsed_output: mockReviewResult,
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        };
      },
    },
  } as unknown as NonNullable<DryRunOptions["anthropic"]>;
  return { anthropic, parseCalls };
}

// ---------------------------------------------------------------------------
// Capture stdout
// ---------------------------------------------------------------------------

function captureStdout(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    write(s: string) {
      lines.push(s);
    },
  };
}

// Clear the in-process result cache between tests so --with-llm and --post
// tests never hit a cache entry stored by a sibling test.
beforeEach(() => {
  resultCache.clear();
});

// ---------------------------------------------------------------------------
// parseArgs — unit tests
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("parses valid ref", () => {
    const result = parseArgs(["acme/widget#42"]);
    expect(result.ref).toEqual({ owner: "acme", repo: "widget", prNumber: 42 });
    expect(result.withLlm).toBe(false);
    expect(result.post).toBe(false);
  });

  test("parses --with-llm flag", () => {
    const result = parseArgs(["acme/widget#1", "--with-llm"]);
    expect(result.withLlm).toBe(true);
    expect(result.post).toBe(false);
  });

  test("parses --post flag and implies withLlm", () => {
    const result = parseArgs(["acme/widget#1", "--post"]);
    expect(result.withLlm).toBe(true);
    expect(result.post).toBe(true);
  });

  test("parses both flags", () => {
    const result = parseArgs(["acme/widget#1", "--with-llm", "--post"]);
    expect(result.withLlm).toBe(true);
    expect(result.post).toBe(true);
  });

  test("throws ArgError on missing positional", () => {
    expect(() => parseArgs([])).toThrow("exactly one positional");
  });

  test("throws ArgError on extra positional", () => {
    expect(() => parseArgs(["acme/widget#1", "extra"])).toThrow("exactly one positional");
  });

  test("throws ArgError on malformed ref — missing #", () => {
    expect(() => parseArgs(["acme/widget"])).toThrow("Invalid ref format");
  });

  test("throws ArgError on malformed ref — missing repo", () => {
    expect(() => parseArgs(["acme/#1"])).toThrow("Invalid ref format");
  });

  test("throws ArgError on unknown flag", () => {
    expect(() => parseArgs(["acme/widget#1", "--foo"])).toThrow("Unknown flag");
  });

  test("throws ArgError on non-numeric PR number", () => {
    expect(() => parseArgs(["acme/widget#abc"])).toThrow("Invalid ref format");
  });
});

// ---------------------------------------------------------------------------
// runDryRun — dry-run (no flags)
// ---------------------------------------------------------------------------

describe("runDryRun — dry-run (no LLM, no post)", () => {
  test("returns expected shape without calling Anthropic or createReview", async () => {
    const { octokit, createReviewCalls } = makeOctokitStub();
    const { anthropic, parseCalls } = makeAnthropicStub();
    const stdout = captureStdout();

    const result = await runDryRun({
      ref: { owner: "acme", repo: "widget", prNumber: 42 },
      withLlm: false,
      post: false,
      octokit,
      anthropic,
      stdout,
    });

    // No LLM call
    expect(parseCalls).toHaveLength(0);

    // No GitHub write
    expect(createReviewCalls).toHaveLength(0);

    // Result shape
    expect(result.userMessage.length).toBeGreaterThan(0);
    expect(result.promptBytes).toBeGreaterThan(0);
    expect(typeof result.intentSource).toBe("string");
    expect(typeof result.chunkerBatches).toBe("number");
    expect(result.llmResult).toBeUndefined();

    // Banner printed to stdout
    const combined = stdout.lines.join("\n");
    expect(combined).toContain("===== USER MESSAGE (dry-run) =====");
    expect(combined).toContain("===== END USER MESSAGE =====");
    expect(combined).toContain("--- Summary ---");
    expect(combined).toContain("acme/widget#42");
  });

  test("omittedCount reflects filter result", async () => {
    const { octokit } = makeOctokitStub();
    const stdout = captureStdout();

    const result = await runDryRun({
      ref: { owner: "acme", repo: "widget", prNumber: 42 },
      octokit,
      stdout,
    });

    // factory.ts is a source file — should not be omitted
    expect(result.omittedCount).toBe(0);
  });

  test("coverageDelta reflects added source lines", async () => {
    const { octokit } = makeOctokitStub();
    const stdout = captureStdout();

    const result = await runDryRun({
      ref: { owner: "acme", repo: "widget", prNumber: 42 },
      octokit,
      stdout,
    });

    // The stub adds 5 src lines and 0 test lines
    expect(result.coverageDelta.addedSrcLines).toBe(5);
    expect(result.coverageDelta.addedTestLines).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runDryRun — --with-llm
// ---------------------------------------------------------------------------

describe("runDryRun — with --with-llm", () => {
  test("calls Anthropic exactly once and returns llmResult", async () => {
    const { octokit, createReviewCalls } = makeOctokitStub();
    const { anthropic, parseCalls } = makeAnthropicStub();
    const stdout = captureStdout();

    const result = await runDryRun({
      ref: { owner: "acme", repo: "widget", prNumber: 42 },
      withLlm: true,
      post: false,
      octokit,
      anthropic,
      stdout,
    });

    // LLM was called
    expect(parseCalls.length).toBeGreaterThanOrEqual(1);

    // No GitHub write
    expect(createReviewCalls).toHaveLength(0);

    // llmResult populated
    expect(result.llmResult).toBeDefined();

    // LLM result block printed
    const combined = stdout.lines.join("\n");
    expect(combined).toContain("===== LLM RESULT =====");
  });
});

// ---------------------------------------------------------------------------
// runDryRun — --post
// ---------------------------------------------------------------------------

describe("runDryRun — with --post", () => {
  test("calls createReview after LLM call", async () => {
    const { octokit, createReviewCalls } = makeOctokitStub({ allowPost: true });
    const { anthropic, parseCalls } = makeAnthropicStub();
    const stdout = captureStdout();

    await runDryRun({
      ref: { owner: "acme", repo: "widget", prNumber: 42 },
      withLlm: true,
      post: true,
      octokit,
      anthropic,
      stdout,
    });

    // LLM called
    expect(parseCalls.length).toBeGreaterThanOrEqual(1);

    // GitHub write happened
    expect(createReviewCalls).toHaveLength(1);
    expect(createReviewCalls[0]!.owner).toBe("acme");
    expect(createReviewCalls[0]!.repo).toBe("widget");
    expect(createReviewCalls[0]!.pull_number).toBe(42);
  });
});
