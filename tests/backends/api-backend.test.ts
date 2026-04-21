/**
 * Tests for the ApiBackend wrapper.
 *
 * We mock `withBreaker` and `withRetry` so that calls go straight through to
 * the stubbed Anthropic client — the existing behaviour is preserved exactly.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { ApiBackend } from "../../src/review/backends/api";
import { ReviewResultSchema } from "../../src/review/schema";
import type { ReviewResult } from "../../src/review/schema";

// ---------------------------------------------------------------------------
// Stub Anthropic client
// ---------------------------------------------------------------------------

function makeClient(result: ReviewResult, cacheRead = 0, cacheCreation = 0) {
  return {
    messages: {
      parse: async (_params: unknown) => ({
        parsed_output: result,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreation,
        },
      }),
    },
  };
}

const approveResult: ReviewResult = {
  verdict: "approve",
  summary: "Looks good.",
  lineComments: [],
};

describe("ApiBackend", () => {
  test("returns parsedOutput and mapped usage on success", async () => {
    const client = makeClient(approveResult, 20, 10);
    const backend = new ApiBackend(client as never);

    const result = await backend.parseReview({
      system: "You are a reviewer.",
      userMessage: "Review this diff.",
      schema: ReviewResultSchema,
      model: "claude-opus-4-7",
      maxTokens: 1000,
    });

    expect(result.parsedOutput).toEqual(approveResult);
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(50);
    expect(result.usage.cache_read_input_tokens).toBe(20);
    expect(result.usage.cache_creation_input_tokens).toBe(10);
  });

  test("throws when parsed_output is null", async () => {
    const client = {
      messages: {
        parse: async () => ({
          parsed_output: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      },
    };
    const backend = new ApiBackend(client as never);

    await expect(
      backend.parseReview({
        system: "sys",
        userMessage: "msg",
        schema: ReviewResultSchema,
        model: "claude-opus-4-7",
        maxTokens: 1000,
      }),
    ).rejects.toThrow("did not match the schema");
  });

  test("zero-fills absent cache fields", async () => {
    const client = {
      messages: {
        parse: async () => ({
          parsed_output: approveResult,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            // cache fields absent
          },
        }),
      },
    };
    const backend = new ApiBackend(client as never);

    const result = await backend.parseReview({
      system: "sys",
      userMessage: "msg",
      schema: ReviewResultSchema,
      model: "claude-opus-4-7",
      maxTokens: 1000,
    });

    expect(result.usage.cache_read_input_tokens).toBe(0);
    expect(result.usage.cache_creation_input_tokens).toBe(0);
  });

  test("withClient returns new backend wrapping supplied client", async () => {
    const originalClient = makeClient({ verdict: "comment", summary: "original", lineComments: [] });
    const newResult: ReviewResult = { verdict: "approve", summary: "new", lineComments: [] };
    const newClient = makeClient(newResult);

    const backend = new ApiBackend(originalClient as never);
    const newBackend = backend.withClient(newClient as never);

    const result = await newBackend.parseReview({
      system: "sys",
      userMessage: "msg",
      schema: ReviewResultSchema,
      model: "claude-opus-4-7",
      maxTokens: 1000,
    });

    expect(result.parsedOutput.summary).toBe("new");
  });
});
