import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { PullRequestDiff } from "../src/github";
import type { Intent } from "../src/jira";
import { runReview, type ReviewResult } from "../src/review";

function makeDiff(patchChars: number): PullRequestDiff {
  return {
    owner: "acme",
    repo: "widget",
    number: 1,
    headSha: "abc",
    baseSha: "def",
    title: "title",
    body: "body",
    files: [
      {
        filename: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "x".repeat(patchChars),
      },
    ],
    totals: { additions: 1, deletions: 0, changedFiles: 1 },
  };
}

const intent: Intent = {
  source: "jira",
  ticketKey: "PROJ-1",
  title: "do the thing",
  description: "do it",
  warnings: [],
};

function stubAnthropicReturning(result: ReviewResult) {
  const calls: Array<Record<string, unknown>> = [];
  const stub = {
    messages: {
      parse: async (params: Record<string, unknown>) => {
        calls.push(params);
        return {
          parsed_output: result,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        };
      },
    },
  } as unknown as Anthropic;
  return { stub, calls };
}

describe("runReview", () => {
  test("returns the LLM's parsed verdict on a normal-sized diff", async () => {
    const { stub, calls } = stubAnthropicReturning({
      verdict: "approve",
      summary: "looks good",
      lineComments: [],
    });

    const out = await runReview(stub, { intent, diff: makeDiff(100) });

    expect(out.result.verdict).toBe("approve");
    expect(out.result.summary).toBe("looks good");
    expect(out.warnings).toEqual([]);
    expect(out.usage?.inputTokens).toBe(100);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("claude-opus-4-7");
  });

  test("system prompt is cached (cache_control on the last system block)", async () => {
    const { stub, calls } = stubAnthropicReturning({
      verdict: "approve",
      summary: "ok",
      lineComments: [],
    });

    await runReview(stub, { intent, diff: makeDiff(100) });

    const system = calls[0]?.system as Array<Record<string, unknown>>;
    expect(Array.isArray(system)).toBe(true);
    const last = system[system.length - 1];
    expect(last?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("fails open with a comment verdict when the diff exceeds the threshold", async () => {
    const { stub, calls } = stubAnthropicReturning({
      verdict: "approve",
      summary: "should not be called",
      lineComments: [],
    });

    const out = await runReview(
      stub,
      { intent, diff: makeDiff(500) },
      { maxDiffChars: 100 },
    );

    expect(calls).toHaveLength(0); // LLM was not invoked
    expect(out.result.verdict).toBe("comment");
    expect(out.result.lineComments).toEqual([]);
    expect(out.result.summary).toContain("too large for automated review");
    expect(out.warnings[0]).toMatch(/diff exceeded review threshold/);
  });

  test("throws when parsed_output is missing", async () => {
    const stub = {
      messages: {
        parse: async () => ({ parsed_output: null, usage: { input_tokens: 0, output_tokens: 0 } }),
      },
    } as unknown as Anthropic;

    await expect(
      runReview(stub, { intent, diff: makeDiff(10) }),
    ).rejects.toThrow(/did not match the schema/);
  });
});
