import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Anthropic from "@anthropic-ai/sdk";
import { fetchGitattributes } from "../github/gitattributes";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
import { ReviewResultSchema } from "./schema";
import { filterDiff } from "./diff-filter";
import { withRetry } from "../util/retry";
import { withBreaker } from "./breaker";
import { runChunkedReview } from "./synthesize";
import { fetchConventions } from "./conventions";
import { computeCoverageDelta } from "./coverage-delta";
import { applicableHeuristics } from "./heuristics/index";
import { incBudgetExhausted, incCoverageSignal, incReviewCache } from "../server/metrics";
import { writeAuditRecord } from "./audit";
import { resultCache } from "./result-cache";
import { getWeeklyTokenSum } from "./budget";
import { recordUsage } from "./usage";
import { log } from "../server/logger";
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

  // -------------------------------------------------------------------------
  // Weekly token budget check (per-repo, no LLM call when exhausted).
  // Must run before any Anthropic I/O so we never burn quota past the cap.
  // -------------------------------------------------------------------------
  const maxWeeklyTokens = input.reviewConfig?.max_weekly_tokens;
  if (maxWeeklyTokens !== undefined) {
    const repoFull = `${input.diff.owner}/${input.diff.repo}`;
    const weeklyUsed = await getWeeklyTokenSum(repoFull);
    if (weeklyUsed >= maxWeeklyTokens) {
      log.info("review.budget_exhausted", {
        evt: "review.budget_exhausted",
        repo: repoFull,
        weekly_used: weeklyUsed,
        weekly_cap: maxWeeklyTokens,
      });

      incBudgetExhausted(repoFull);

      // Record usage so operators can grep for budget_exhausted events.
      // Tokens are 0 — no LLM was invoked.
      await recordUsage({
        repo: repoFull,
        pr: input.diff.number,
        headSha: input.diff.headSha,
        model,
        verdict: "budget_exhausted",
        inputTokens: 0,
        outputTokens: 0,
      });

      return {
        result: {
          verdict: "comment",
          summary:
            `This repository has reached its weekly automated-review token budget ` +
            `(${weeklyUsed.toLocaleString()} / ${maxWeeklyTokens.toLocaleString()} tokens used this week). ` +
            `Full LLM reviews will resume when the ISO week rolls over on Monday 00:00 UTC. ` +
            `Human reviewers are encouraged in the meantime.`,
          lineComments: [],
        },
        warnings: ["weekly token budget exhausted"],
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Result cache check — avoids redundant LLM calls when a CI provider fires
  // check_suite.completed multiple times on the same head SHA (retries, branch
  // protection re-evaluations, etc.). Budget-exhausted results are intentionally
  // NOT cached above so the block lifts immediately when the window rolls.
  // ---------------------------------------------------------------------------
  const repoFull = `${input.diff.owner}/${input.diff.repo}`;
  const headSha = input.diff.headSha;
  const cacheKey = `${repoFull}@${headSha}`;

  const cached = resultCache.get(cacheKey);
  if (cached) {
    log.info("review.cache_hit", { repo: repoFull, headSha });
    incReviewCache("hit");
    return cached;
  }
  incReviewCache("miss");

  // Fetch conventions and .gitattributes in parallel — both are GitHub reads
  // with no ordering dependency. Errors inside each helper are already
  // handled (silent on 404, warn-log on 5xx), so Promise.all never rejects.
  const [conventions, gitattributes] = input.octokit
    ? await Promise.all([
        fetchConventions({
          octokit: input.octokit,
          owner: input.diff.owner,
          repo: input.diff.repo,
          ref: input.diff.headSha,
        }),
        fetchGitattributes({
          octokit: input.octokit,
          owner: input.diff.owner,
          repo: input.diff.repo,
          ref: input.diff.headSha,
        }),
      ])
    : [{ sections: [], totalBytes: 0 }, null];

  // Filter out lockfiles, binaries, and generated files before measuring size
  // or building the prompt.  Per-repo glob overrides come from repos.yaml.
  const filterResult = filterDiff(input.diff.files, {
    include: input.reviewConfig?.include_paths,
    exclude: input.reviewConfig?.exclude_paths,
    gitattributes: gitattributes ?? undefined,
  });

  // Compute coverage delta on kept files only — we don't want to flag symbols
  // that are in omitted/filtered files since those won't appear in the prompt.
  const omittedPathSet = new Set(filterResult.omitted.map((o) => o.path));
  const keptFiles = input.diff.files.filter(
    (f) => !omittedPathSet.has(f.filename),
  );
  const coverageDelta = computeCoverageDelta(keptFiles);
  const heuristics = applicableHeuristics(keptFiles);

  // Emit metric — one bump per review, not per file, to avoid cardinality issues.
  if (coverageDelta.addedSrcLines === 0) {
    incCoverageSignal("no_new_src");
  } else if (coverageDelta.addedTestLines > 0) {
    incCoverageSignal("has_tests");
  } else {
    incCoverageSignal("untested");
  }

  // Measure diff size against the kept files only — use a Set for O(n) lookup.
  const diffSize = input.diff.files.reduce(
    (sum, f) =>
      omittedPathSet.has(f.filename) ? sum : sum + (f.patch?.length ?? 0),
    0,
  );

  const isLarge = diffSize > maxDiffChars;
  const useChunked = mode === "chunked" || (mode === "auto" && isLarge);

  if (useChunked) {
    const chunkedResult = await runChunkedReview(anthropic, input, options);
    // Only cache chunked results that are complete.  A pass-2 overflow warning
    // indicates the synthesized output may be truncated — safer to re-run if
    // the same SHA is requested again rather than serving a partial review.
    const hasOverflow = chunkedResult.warnings.some((w) =>
      w.includes("pass-2 overflow"),
    );
    if (!hasOverflow) {
      resultCache.set(cacheKey, chunkedResult);
    }
    return chunkedResult;
  }

  // Single-pass path (mode === "single" or auto + small diff).
  if (mode === "single" && isLarge) {
    // Operator explicitly opted into single-pass despite size — fail open.
    const failOpenResult: RunReviewOutput = {
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
    resultCache.set(cacheKey, failOpenResult);
    return failOpenResult;
  }

  const userMessage = buildUserMessage({
    ...input,
    conventions,
    filterResult,
    coverageDelta,
    heuristics,
  });

  // withBreaker gates BEFORE withRetry so a tripped breaker short-circuits
  // the retry loop entirely rather than burning quota on repeated attempts.
  const response = await withBreaker("anthropic", () =>
    withRetry(() =>
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
    ),
  );

  if (!response.parsed_output) {
    throw new Error("LLM returned a response that did not match the schema");
  }

  const usageOut = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheCreationInputTokens:
      response.usage.cache_creation_input_tokens ?? undefined,
    cacheReadInputTokens:
      response.usage.cache_read_input_tokens ?? undefined,
  };

  await writeAuditRecord({
    repo: `${input.diff.owner}/${input.diff.repo}`,
    pr: input.diff.number,
    headSha: input.diff.headSha,
    mode: "single",
    promptSystem: SYSTEM_PROMPT,
    promptUser: userMessage,
    responseRaw: response.parsed_output,
    usage: usageOut,
    verdict: response.parsed_output.verdict,
    warnings: [],
  });

  const singlePassResult: RunReviewOutput = {
    result: response.parsed_output,
    warnings: [],
    usage: usageOut,
  };
  resultCache.set(cacheKey, singlePassResult);
  return singlePassResult;
}

export { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
export {
  fetchConventions,
  conventionsCache,
  type ConventionsResult,
  type ConventionSection,
  type FetchConventionsInput,
} from "./conventions";
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
  makeAnthropicCircuitOpenError,
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
export {
  CircuitBreaker,
  CircuitOpenError,
  getBreaker,
  withBreaker,
  type BreakerState,
  type BreakerOptions,
  type CheckResult,
} from "./breaker";
