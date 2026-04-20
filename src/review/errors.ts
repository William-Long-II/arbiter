/**
 * Structured error taxonomy for the review pipeline.
 *
 * Every catch site in the pipeline wraps thrown errors into a `ReviewError`
 * using `toReviewError`. The central helper `logReviewError` emits a
 * machine-readable JSON log line so operators can build dashboards and alerts
 * keyed on stable `code` values.
 *
 * Metrics counter `reviewme_review_failures_total{stage,code}` is intentionally
 * left to issue #2 (observability / metrics). This module only defines the enum
 * and the logging helper so #2 has a stable set of codes to consume.
 */

import { log } from "../server/logger";

// ---------------------------------------------------------------------------
// Stage enum
// ---------------------------------------------------------------------------

export type PipelineStage =
  | "diff-fetch"
  | "intent-resolve"
  | "llm-review"
  | "post-review";

// ---------------------------------------------------------------------------
// Error code enum
// ---------------------------------------------------------------------------

export const ReviewErrorCode = {
  /** GitHub API returned a non-2xx status while fetching the PR diff. */
  GITHUB_DIFF_FETCH_FAILED: "GITHUB_DIFF_FETCH_FAILED",
  /** Jira returned a 404 or an equivalent "not found" response for the ticket key. */
  JIRA_TICKET_NOT_FOUND: "JIRA_TICKET_NOT_FOUND",
  /** Anthropic responded with a 429 (rate-limit / overloaded). */
  ANTHROPIC_RATE_LIMITED: "ANTHROPIC_RATE_LIMITED",
  /** Anthropic responded successfully but `parsed_output` was null or failed schema validation. */
  ANTHROPIC_INVALID_TOOL_OUTPUT: "ANTHROPIC_INVALID_TOOL_OUTPUT",
  /** GitHub rejected the review POST with a 403 (forbidden / missing permissions). */
  POST_REVIEW_FORBIDDEN: "POST_REVIEW_FORBIDDEN",
  /** The PR diff exceeded the configured character budget and was not reviewed. */
  DIFF_TOO_LARGE: "DIFF_TOO_LARGE",
  /** Anthropic calls rejected because the circuit breaker is open. */
  ANTHROPIC_CIRCUIT_OPEN: "ANTHROPIC_CIRCUIT_OPEN",
} as const;

export type ReviewErrorCode =
  (typeof ReviewErrorCode)[keyof typeof ReviewErrorCode];

// ---------------------------------------------------------------------------
// Discriminated union per stage
// ---------------------------------------------------------------------------

export type ReviewErrorBase = {
  /** Stable machine-readable error code. */
  code: ReviewErrorCode;
  /** Pipeline stage where the error occurred. */
  stage: PipelineStage;
  /** Whether the caller can safely retry this operation. */
  retryable: boolean;
  /** Human-readable description. */
  message: string;
  /** Original thrown value, if available. */
  cause?: unknown;
};

// Narrow variants per stage for pattern-match exhaustiveness where desired.
export type DiffFetchError = ReviewErrorBase & {
  stage: "diff-fetch";
  code:
    | typeof ReviewErrorCode.GITHUB_DIFF_FETCH_FAILED
    | typeof ReviewErrorCode.DIFF_TOO_LARGE;
};

export type IntentResolveError = ReviewErrorBase & {
  stage: "intent-resolve";
  code: typeof ReviewErrorCode.JIRA_TICKET_NOT_FOUND;
};

export type LlmReviewError = ReviewErrorBase & {
  stage: "llm-review";
  code:
    | typeof ReviewErrorCode.ANTHROPIC_RATE_LIMITED
    | typeof ReviewErrorCode.ANTHROPIC_INVALID_TOOL_OUTPUT
    | typeof ReviewErrorCode.ANTHROPIC_CIRCUIT_OPEN;
};

export type PostReviewError = ReviewErrorBase & {
  stage: "post-review";
  code: typeof ReviewErrorCode.POST_REVIEW_FORBIDDEN;
};

/** Discriminated union covering every pipeline stage. */
export type ReviewError =
  | DiffFetchError
  | IntentResolveError
  | LlmReviewError
  | PostReviewError;

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isReviewError(value: unknown): value is ReviewError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "stage" in value &&
    "retryable" in value &&
    typeof (value as ReviewError).code === "string" &&
    (value as ReviewError).code in ReviewErrorCode
  );
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function makeDiffFetchError(
  cause: unknown,
  opts: { message?: string } = {},
): DiffFetchError {
  return {
    code: ReviewErrorCode.GITHUB_DIFF_FETCH_FAILED,
    stage: "diff-fetch",
    retryable: true,
    message: opts.message ?? extractMessage(cause) ?? "failed to fetch PR diff",
    cause,
  };
}

export function makeDiffTooLargeError(diffSize: number, limit: number): DiffFetchError {
  return {
    code: ReviewErrorCode.DIFF_TOO_LARGE,
    stage: "diff-fetch",
    retryable: false,
    message: `diff size ${diffSize} exceeds limit ${limit}`,
  };
}

export function makeJiraNotFoundError(
  ticketKey: string,
  cause: unknown,
): IntentResolveError {
  return {
    code: ReviewErrorCode.JIRA_TICKET_NOT_FOUND,
    stage: "intent-resolve",
    retryable: false,
    message: `jira ticket not found: ${ticketKey}`,
    cause,
  };
}

export function makeAnthropicRateLimitedError(cause: unknown): LlmReviewError {
  return {
    code: ReviewErrorCode.ANTHROPIC_RATE_LIMITED,
    stage: "llm-review",
    retryable: true,
    message: "anthropic rate limit exceeded",
    cause,
  };
}

export function makeAnthropicCircuitOpenError(
  cause: unknown,
  retryAfterSeconds: number,
): LlmReviewError {
  return {
    code: ReviewErrorCode.ANTHROPIC_CIRCUIT_OPEN,
    stage: "llm-review",
    retryable: false,
    message: `anthropic circuit breaker open; retry in ${retryAfterSeconds}s`,
    cause,
  };
}

export function makeAnthropicInvalidOutputError(cause: unknown): LlmReviewError {
  return {
    code: ReviewErrorCode.ANTHROPIC_INVALID_TOOL_OUTPUT,
    stage: "llm-review",
    retryable: false,
    message: extractMessage(cause) ?? "anthropic returned invalid tool output",
    cause,
  };
}

export function makePostReviewForbiddenError(cause: unknown): PostReviewError {
  return {
    code: ReviewErrorCode.POST_REVIEW_FORBIDDEN,
    stage: "post-review",
    retryable: false,
    message: "forbidden: insufficient permissions to post review",
    cause,
  };
}

// ---------------------------------------------------------------------------
// Wrapping helpers — convert raw thrown values into ReviewError at each stage
// ---------------------------------------------------------------------------

/**
 * Wrap an error thrown during the diff-fetch stage.
 * Re-throws as-is if it is already a `ReviewError`.
 */
export function wrapDiffFetchError(err: unknown): DiffFetchError {
  if (isReviewError(err) && err.stage === "diff-fetch") return err as DiffFetchError;
  return makeDiffFetchError(err);
}

/**
 * Wrap an error thrown during the intent-resolve stage.
 * Maps Jira 404 responses to `JIRA_TICKET_NOT_FOUND`; re-throws `ReviewError`
 * unmodified.
 */
export function wrapIntentResolveError(
  err: unknown,
  ticketKey: string,
): IntentResolveError {
  if (isReviewError(err) && err.stage === "intent-resolve") return err as IntentResolveError;
  const status = extractHttpStatus(err);
  if (status === 404) return makeJiraNotFoundError(ticketKey, err);
  return makeJiraNotFoundError(ticketKey, err);
}

/**
 * Wrap an error thrown during the LLM-review stage.
 * Maps Anthropic 429 to `ANTHROPIC_RATE_LIMITED`; invalid output to
 * `ANTHROPIC_INVALID_TOOL_OUTPUT`.
 */
export function wrapLlmReviewError(err: unknown): LlmReviewError {
  if (isReviewError(err) && err.stage === "llm-review") return err as LlmReviewError;
  // Duck-type CircuitOpenError to avoid a circular import (breaker → metrics,
  // errors ← breaker would be circular if we imported CircuitOpenError here).
  if (
    err instanceof Error &&
    err.name === "CircuitOpenError" &&
    "retryAfterSeconds" in err
  ) {
    return makeAnthropicCircuitOpenError(
      err,
      (err as { retryAfterSeconds: number }).retryAfterSeconds,
    );
  }
  const status = extractHttpStatus(err);
  if (status === 429) return makeAnthropicRateLimitedError(err);
  const msg = extractMessage(err) ?? "";
  if (msg.includes("did not match the schema")) return makeAnthropicInvalidOutputError(err);
  // Default: treat as invalid output for any other LLM failure
  return makeAnthropicInvalidOutputError(err);
}

/**
 * Wrap an error thrown during the post-review stage.
 * Maps HTTP 403 to `POST_REVIEW_FORBIDDEN`.
 */
export function wrapPostReviewError(err: unknown): PostReviewError {
  if (isReviewError(err) && err.stage === "post-review") return err as PostReviewError;
  return makePostReviewForbiddenError(err);
}

// ---------------------------------------------------------------------------
// Central error logger
// ---------------------------------------------------------------------------

export type ReviewErrorContext = {
  repo: string;
  pr: number;
};

/**
 * Emit a structured `review.error` log line with stable fields for log
 * pipeline aggregation and alerting.
 */
export function logReviewError(
  error: ReviewError,
  context: ReviewErrorContext,
  extra?: Record<string, unknown>,
): void {
  log.error("review.error", {
    evt: "review.error",
    code: error.code,
    stage: error.stage,
    retryable: error.retryable,
    repo: context.repo,
    pr: context.pr,
    message: error.message,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

function extractMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return undefined;
}

function extractHttpStatus(err: unknown): number | undefined {
  if (err !== null && typeof err === "object") {
    const status = (err as Record<string, unknown>)["status"];
    if (typeof status === "number") return status;
  }
  return undefined;
}
