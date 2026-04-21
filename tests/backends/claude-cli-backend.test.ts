/**
 * Tests for the ClaudeCliBackend.
 *
 * We inject a `spawnFn` instead of using `Bun.spawn` so there is no
 * dependency on the real `claude` binary.
 */

import { describe, test, expect } from "bun:test";
import { ClaudeCliBackend, checkClaudeCliAvailable } from "../../src/review/backends/claude-cli";
import { ReviewResultSchema } from "../../src/review/schema";
import type { ReviewResult } from "../../src/review/schema";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers to build mock spawn functions
// ---------------------------------------------------------------------------

type MockSpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function makeSpawnFn(mock: MockSpawnResult) {
  return (_cmd: string[], _opts: unknown) => ({
    stdout: { text: async () => mock.stdout },
    stderr: { text: async () => mock.stderr },
    exited: Promise.resolve(mock.exitCode),
  });
}

/** Build the JSON envelope `claude --output-format json` emits. */
function cliEnvelope(result: ReviewResult, usage = { input_tokens: 100, output_tokens: 50 }) {
  return JSON.stringify({
    type: "result",
    result: JSON.stringify(result),
    usage,
  });
}

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe("ClaudeCliBackend - happy path", () => {
  test("parses valid JSON response", async () => {
    const expected: ReviewResult = {
      verdict: "approve",
      summary: "All good.",
      lineComments: [],
    };

    const spawn = makeSpawnFn({ stdout: cliEnvelope(expected), stderr: "", exitCode: 0 });
    const backend = new ClaudeCliBackend(spawn as never);

    const result = await backend.parseReview({
      system: "You are a reviewer.",
      userMessage: "Review this.",
      schema: ReviewResultSchema,
      model: "claude-opus-4-7",
      maxTokens: 1000,
    });

    expect(result.parsedOutput.verdict).toBe("approve");
    expect(result.parsedOutput.summary).toBe("All good.");
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(50);
  });

  test("maps usage fields correctly from snake_case", async () => {
    const expected: ReviewResult = { verdict: "comment", summary: "See notes.", lineComments: [] };
    const envelope = JSON.stringify({
      result: JSON.stringify(expected),
      usage: {
        input_tokens: 200,
        output_tokens: 75,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
      },
    });

    const spawn = makeSpawnFn({ stdout: envelope, stderr: "", exitCode: 0 });
    const backend = new ClaudeCliBackend(spawn as never);

    const result = await backend.parseReview({
      system: "sys",
      userMessage: "msg",
      schema: ReviewResultSchema,
      model: "claude-opus-4-7",
      maxTokens: 1000,
    });

    expect(result.usage.cache_read_input_tokens).toBe(50);
    expect(result.usage.cache_creation_input_tokens).toBe(10);
  });

  test("extracts content from messages array format", async () => {
    const expected: ReviewResult = { verdict: "approve", summary: "LGTM", lineComments: [] };
    const envelope = JSON.stringify({
      messages: [
        { role: "user", content: "review" },
        { role: "assistant", content: JSON.stringify(expected) },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const spawn = makeSpawnFn({ stdout: envelope, stderr: "", exitCode: 0 });
    const backend = new ClaudeCliBackend(spawn as never);

    const result = await backend.parseReview({
      system: "sys",
      userMessage: "msg",
      schema: ReviewResultSchema,
      model: "claude-opus-4-7",
      maxTokens: 1000,
    });

    expect(result.parsedOutput.summary).toBe("LGTM");
  });

  test("extracts content from content-block array format", async () => {
    const expected: ReviewResult = { verdict: "comment", summary: "Review note", lineComments: [] };
    const envelope = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(expected) }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const spawn = makeSpawnFn({ stdout: envelope, stderr: "", exitCode: 0 });
    const backend = new ClaudeCliBackend(spawn as never);

    const result = await backend.parseReview({
      system: "sys",
      userMessage: "msg",
      schema: ReviewResultSchema,
      model: "claude-opus-4-7",
      maxTokens: 1000,
    });

    expect(result.parsedOutput.summary).toBe("Review note");
  });
});

// ---------------------------------------------------------------------------
// Fallback / error-path tests
// ---------------------------------------------------------------------------

describe("ClaudeCliBackend - fallback paths", () => {
  test("returns fallback on non-zero exit code", async () => {
    const spawn = makeSpawnFn({ stdout: "", stderr: "command not found", exitCode: 1 });
    const backend = new ClaudeCliBackend(spawn as never);

    const result = await backend.parseReview({
      system: "sys",
      userMessage: "msg",
      schema: ReviewResultSchema,
      model: "claude-opus-4-7",
      maxTokens: 1000,
    });

    expect(result.parsedOutput.verdict).toBe("comment");
    expect(result.parsedOutput.summary).toContain("human review recommended");
    expect(result.usage.input_tokens).toBe(0);
  });

  test("returns fallback on malformed envelope JSON", async () => {
    const spawn = makeSpawnFn({ stdout: "not json at all", stderr: "", exitCode: 0 });
    const backend = new ClaudeCliBackend(spawn as never);

    const result = await backend.parseReview({
      system: "sys",
      userMessage: "msg",
      schema: ReviewResultSchema,
      model: "claude-opus-4-7",
      maxTokens: 1000,
    });

    expect(result.parsedOutput.verdict).toBe("comment");
    expect(result.parsedOutput.lineComments).toHaveLength(0);
  });

  test("returns fallback on malformed content JSON", async () => {
    const envelope = JSON.stringify({
      result: "{ this is not valid json }",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const spawn = makeSpawnFn({ stdout: envelope, stderr: "", exitCode: 0 });
    const backend = new ClaudeCliBackend(spawn as never);

    const result = await backend.parseReview({
      system: "sys",
      userMessage: "msg",
      schema: ReviewResultSchema,
      model: "claude-opus-4-7",
      maxTokens: 1000,
    });

    expect(result.parsedOutput.verdict).toBe("comment");
  });

  test("returns fallback when schema validation fails", async () => {
    // Missing required 'verdict' field
    const badOutput = JSON.stringify({ summary: "ok", lineComments: [] });
    const envelope = JSON.stringify({
      result: badOutput,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const spawn = makeSpawnFn({ stdout: envelope, stderr: "", exitCode: 0 });
    const backend = new ClaudeCliBackend(spawn as never);

    const result = await backend.parseReview({
      system: "sys",
      userMessage: "msg",
      schema: ReviewResultSchema,
      model: "claude-opus-4-7",
      maxTokens: 1000,
    });

    expect(result.parsedOutput.verdict).toBe("comment");
    expect(result.parsedOutput.summary).toContain("human review recommended");
  });

  test("returns batch fallback (empty file_summaries) for batch schema", async () => {
    const BatchSchema = z.object({ file_summaries: z.array(z.object({ path: z.string() })) });
    const spawn = makeSpawnFn({ stdout: "not json", stderr: "", exitCode: 0 });
    const backend = new ClaudeCliBackend(spawn as never);

    const result = await backend.parseReview({
      system: "sys",
      userMessage: "msg",
      schema: BatchSchema,
      model: "claude-opus-4-7",
      maxTokens: 1000,
    });

    expect((result.parsedOutput as { file_summaries: unknown[] }).file_summaries).toHaveLength(0);
  });

  test("returns fallback when is_error flag is set", async () => {
    const envelope = JSON.stringify({ is_error: true, result: "Something went wrong" });
    const spawn = makeSpawnFn({ stdout: envelope, stderr: "", exitCode: 0 });
    const backend = new ClaudeCliBackend(spawn as never);

    const result = await backend.parseReview({
      system: "sys",
      userMessage: "msg",
      schema: ReviewResultSchema,
      model: "claude-opus-4-7",
      maxTokens: 1000,
    });

    expect(result.parsedOutput.verdict).toBe("comment");
  });
});

// ---------------------------------------------------------------------------
// checkClaudeCliAvailable tests
// ---------------------------------------------------------------------------

describe("checkClaudeCliAvailable", () => {
  test("returns ok:true when claude --version succeeds", async () => {
    const spawn = makeSpawnFn({ stdout: "claude 1.0.0\n", stderr: "", exitCode: 0 });
    const result = await checkClaudeCliAvailable(spawn as never);
    expect(result.ok).toBe(true);
  });

  test("returns ok:false on non-zero exit", async () => {
    const spawn = makeSpawnFn({ stdout: "", stderr: "not found", exitCode: 127 });
    const result = await checkClaudeCliAvailable(spawn as never);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toContain("127");
  });

  test("returns ok:false on empty output", async () => {
    const spawn = makeSpawnFn({ stdout: "", stderr: "", exitCode: 0 });
    const result = await checkClaudeCliAvailable(spawn as never);
    expect(result.ok).toBe(false);
  });

  test("returns ok:false on spawn error", async () => {
    const errSpawn = (_cmd: string[], _opts: unknown) => {
      throw new Error("ENOENT: no such file");
    };
    const result = await checkClaudeCliAvailable(errSpawn as never);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toContain("ENOENT");
  });
});
