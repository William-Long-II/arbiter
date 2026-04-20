import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Anthropic from "@anthropic-ai/sdk";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
import { ReviewResultSchema } from "./schema";
import { filterDiff } from "./diff-filter";
import { withRetry } from "../util/retry";
import { runChunkedReview } from "./synthesize";
import {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_DIFF_CHARS,
  type RunReviewInput,
  type RunReviewOptions,
  type RunReviewOutput,
} from "./types";

export { DEFAULT_MODEL, DEFAULT_MAX_TOKENS, DEFAULT_MAX_DIFF_CHARS };
export type { RunReviewInput, RunReviewOptions, RunReviewOutput };

/** Valid values for the REVIEW_MODE environment variable. */
export type ReviewMode = "auto" | "single" | "chunked";

/**
 * Reads REVIEW_MODE from the environment. Falls back to "auto".
 * Any unrecognised value is treated as "auto" so operator mistakes
 * never break the pipeline.
 */
export function getReviewMode(): ReviewMode {
  const raw = process.env["REVIEW_MODE"];
  if (raw === "single" || raw === "chunked") return raw;
  return "auto";
}

/**
 * Runs the LLM review pass and returns a structured verdict.
 *
 * Routing:
 * - REVIEW_MODE=single (or auto + small diff) → single-pass as before.
 * - REVIEW_MODE=chunked (or auto + large diff) → two-pass summarize-synthesize.
 * - REVIEW_MODE=single + large diff → fail-open (explicit operator opt-out).
 */
export async function runReview(
  anthropic: Anthropic,
  input: RunReviewInput,
  options: RunReviewOptions = {},
): Promise<RunReviewOutput> {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxDiffChars = options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
  const mode = getReviewMode();

  // Filter out lockfiles, binaries, and generated files before measuring size
  // or building the prompt.  Per-repo glob overrides come from repos.yaml.
  const filterResult = filterDiff(input.diff.files, {
    include: input.reviewConfig?.include_paths,
    exclude: input.reviewConfig?.exclude_paths,
  });

  // Measure diff size against the kept files only — use a Set for O(n) lookup.
  const omittedPathSet = new Set(filterResult.omitted.map((o) => o.path));
  const diffSize = input.diff.files.reduce(
    (sum, f) =>
      omittedPathSet.has(f.filename) ? sum : sum + (f.patch?.length ?? 0),
    0,
  );

  const isLarge = diffSize > maxDiffChars;

  // Determine which path to take.
  const useChunked =
    mode === "chunked" || (mode === "auto" && isLarge);

  if (useChunked) {
    return runChunkedReview(anthropic, input, options);
  }

  // Single-pass path (mode === "single" or auto + small diff).
  if (mode === "single" && isLarge) {
    // Operator explicitly opted into single-pass despite size — fail open.
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

  const userMessage = buildUserMessage({ ...input, filterResult });

  const response = await withRetry(() =>
    anthropic.messages.parse({
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
    }),
  );

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
export { filterDiff, OMITTED_FILES_SENTINEL } from "./diff-filter";
export type { FilterDiffOptions, FilterDiffResult, OmittedFile } from "./diff-filter";
export {
  ReviewErrorCode,
  isReviewError,
  logReviewError,
  makeDiffFetchError,
  makeDiffTooLargeError,
  makeJiraNotFoundError,
  makeAnthropicRateLimitedError,
  makeAnthropicInvalidOutputError,
  makePostReviewForbiddenError,
  wrapDiffFetchError,
  wrapIntentResolveError,
  wrapLlmReviewError,
  wrapPostReviewError,
  type ReviewError,
  type PipelineStage,
  type ReviewErrorBase,
  type DiffFetchError,
  type IntentResolveError,
  type LlmReviewError,
  type PostReviewError,
  type ReviewErrorContext,
} from "./errors";
