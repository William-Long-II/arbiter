import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { PullRequestDiff } from "../github";
import type { Intent } from "../jira";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
import { ReviewResultSchema, type ReviewResult } from "./schema";

export const DEFAULT_MODEL = "claude-opus-4-7";
export const DEFAULT_MAX_TOKENS = 16_000;
export const DEFAULT_MAX_DIFF_CHARS = 150_000;

export type RunReviewInput = {
  intent: Intent;
  diff: PullRequestDiff;
};

export type RunReviewOptions = {
  model?: string;
  maxTokens?: number;
  maxDiffChars?: number;
};

export type RunReviewOutput = {
  result: ReviewResult;
  warnings: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
};

/**
 * Runs the LLM review pass and returns a structured verdict.
 * Fails open with a single summary-only comment when the diff is too large
 * to review effectively — the bot will never block a PR that overflows.
 */
export async function runReview(
  anthropic: Anthropic,
  input: RunReviewInput,
  options: RunReviewOptions = {},
): Promise<RunReviewOutput> {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;

  const diffSize = input.diff.files.reduce(
    (sum, f) => sum + (f.patch?.length ?? 0),
    0,
  );

  if (diffSize > maxDiffChars) {
    return {
      result: {
        verdict: "comment",
        summary:
          `This PR's diff is too large for automated review ` +
          `(${diffSize.toLocaleString()} patch characters, limit ${maxDiffChars.toLocaleString()}). ` +
          `CI is green, so the bot is leaving this one to human reviewers. ` +
          `If you'd like a targeted review, consider splitting the change or pointing the bot at a specific file.`,
        lineComments: [],
      },
      warnings: [
        `diff exceeded review threshold (${diffSize} > ${maxDiffChars}); fail-open`,
      ],
    };
  }

  const userMessage = buildUserMessage(input);

  const response = await anthropic.messages.parse({
    model,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
    output_config: {
      format: zodOutputFormat(ReviewResultSchema),
    },
  });

  if (!response.parsed_output) {
    throw new Error("LLM returned a response that did not match the schema");
  }

  return {
    result: response.parsed_output,
    warnings: [],
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens:
        response.usage.cache_creation_input_tokens ?? undefined,
      cacheReadInputTokens:
        response.usage.cache_read_input_tokens ?? undefined,
    },
  };
}

export { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
export { ReviewResultSchema, type ReviewResult, type LineComment } from "./schema";
export { createAnthropic } from "./client";
