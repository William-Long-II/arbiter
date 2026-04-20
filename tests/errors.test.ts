import { describe, expect, test } from "bun:test";
import {
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
} from "../src/review/errors";

// ---------------------------------------------------------------------------
// Enum stability snapshot — renames or removals break this test on purpose
// ---------------------------------------------------------------------------

describe("ReviewErrorCode stability", () => {
  test("all codes are stable string literals", () => {
    expect(ReviewErrorCode).toEqual({
      GITHUB_DIFF_FETCH_FAILED: "GITHUB_DIFF_FETCH_FAILED",
      JIRA_TICKET_NOT_FOUND: "JIRA_TICKET_NOT_FOUND",
      ANTHROPIC_RATE_LIMITED: "ANTHROPIC_RATE_LIMITED",
      ANTHROPIC_INVALID_TOOL_OUTPUT: "ANTHROPIC_INVALID_TOOL_OUTPUT",
      POST_REVIEW_FORBIDDEN: "POST_REVIEW_FORBIDDEN",
      DIFF_TOO_LARGE: "DIFF_TOO_LARGE",
    });
  });

  test("enum has exactly 6 codes", () => {
    expect(Object.keys(ReviewErrorCode)).toHaveLength(6);
  });

  test("every code value equals its key (self-documenting)", () => {
    for (const key of Object.keys(ReviewErrorCode) as Array<keyof typeof ReviewErrorCode>) {
      expect(ReviewErrorCode[key]).toBe(key);
    }
  });
});

// ---------------------------------------------------------------------------
// isReviewError type guard
// ---------------------------------------------------------------------------

describe("isReviewError", () => {
  test("returns true for a valid ReviewError", () => {
    const err = makeDiffFetchError(new Error("boom"));
    expect(isReviewError(err)).toBe(true);
  });

  test("returns false for a plain Error", () => {
    expect(isReviewError(new Error("nope"))).toBe(false);
  });

  test("returns false for null", () => {
    expect(isReviewError(null)).toBe(false);
  });

  test("returns false for a string", () => {
    expect(isReviewError("GITHUB_DIFF_FETCH_FAILED")).toBe(false);
  });

  test("returns false for an object missing the code field", () => {
    expect(isReviewError({ stage: "diff-fetch", retryable: true })).toBe(false);
  });

  test("returns false for an object with an unknown code", () => {
    expect(
      isReviewError({ code: "MADE_UP_CODE", stage: "diff-fetch", retryable: false }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Factory helpers — shape assertions per stage
// ---------------------------------------------------------------------------

describe("factory helpers", () => {
  test("makeDiffFetchError produces correct shape", () => {
    const cause = new Error("403 Forbidden");
    const err = makeDiffFetchError(cause);
    expect(err.code).toBe("GITHUB_DIFF_FETCH_FAILED");
    expect(err.stage).toBe("diff-fetch");
    expect(err.retryable).toBe(true);
    expect(err.cause).toBe(cause);
    expect(typeof err.message).toBe("string");
  });

  test("makeDiffFetchError uses explicit message when provided", () => {
    const err = makeDiffFetchError(null, { message: "custom msg" });
    expect(err.message).toBe("custom msg");
  });

  test("makeDiffFetchError extracts message from Error cause", () => {
    const err = makeDiffFetchError(new Error("upstream 500"));
    expect(err.message).toContain("upstream 500");
  });

  test("makeDiffTooLargeError has correct code and is not retryable", () => {
    const err = makeDiffTooLargeError(200_000, 150_000);
    expect(err.code).toBe("DIFF_TOO_LARGE");
    expect(err.stage).toBe("diff-fetch");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("200000");
    expect(err.message).toContain("150000");
  });

  test("makeJiraNotFoundError has correct code and is not retryable", () => {
    const err = makeJiraNotFoundError("PROJ-42", new Error("404"));
    expect(err.code).toBe("JIRA_TICKET_NOT_FOUND");
    expect(err.stage).toBe("intent-resolve");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("PROJ-42");
  });

  test("makeAnthropicRateLimitedError is retryable", () => {
    const err = makeAnthropicRateLimitedError(new Error("429"));
    expect(err.code).toBe("ANTHROPIC_RATE_LIMITED");
    expect(err.stage).toBe("llm-review");
    expect(err.retryable).toBe(true);
  });

  test("makeAnthropicInvalidOutputError is not retryable", () => {
    const err = makeAnthropicInvalidOutputError(new Error("bad output"));
    expect(err.code).toBe("ANTHROPIC_INVALID_TOOL_OUTPUT");
    expect(err.stage).toBe("llm-review");
    expect(err.retryable).toBe(false);
  });

  test("makePostReviewForbiddenError is not retryable", () => {
    const err = makePostReviewForbiddenError(new Error("403"));
    expect(err.code).toBe("POST_REVIEW_FORBIDDEN");
    expect(err.stage).toBe("post-review");
    expect(err.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wrapping helpers — simulate what the pipeline stages do
// ---------------------------------------------------------------------------

describe("wrapDiffFetchError", () => {
  test("wraps a generic error into GITHUB_DIFF_FETCH_FAILED", () => {
    const raw = new Error("GitHub API error");
    const wrapped = wrapDiffFetchError(raw);
    expect(wrapped.code).toBe("GITHUB_DIFF_FETCH_FAILED");
    expect(wrapped.stage).toBe("diff-fetch");
    expect(wrapped.cause).toBe(raw);
  });

  test("passes an existing DiffFetchError through unchanged", () => {
    const existing = makeDiffFetchError(null);
    const result = wrapDiffFetchError(existing);
    expect(result).toBe(existing);
  });
});

describe("wrapIntentResolveError", () => {
  test("wraps a 404 error into JIRA_TICKET_NOT_FOUND", () => {
    const raw = Object.assign(new Error("not found"), { status: 404 });
    const wrapped = wrapIntentResolveError(raw, "PROJ-99");
    expect(wrapped.code).toBe("JIRA_TICKET_NOT_FOUND");
    expect(wrapped.stage).toBe("intent-resolve");
    expect(wrapped.message).toContain("PROJ-99");
  });

  test("wraps a non-404 error into JIRA_TICKET_NOT_FOUND with the key", () => {
    const raw = new Error("network timeout");
    const wrapped = wrapIntentResolveError(raw, "PROJ-1");
    expect(wrapped.code).toBe("JIRA_TICKET_NOT_FOUND");
    expect(wrapped.message).toContain("PROJ-1");
    expect(wrapped.cause).toBe(raw);
  });

  test("passes an existing IntentResolveError through unchanged", () => {
    const existing = makeJiraNotFoundError("X-1", null);
    const result = wrapIntentResolveError(existing, "X-1");
    expect(result).toBe(existing);
  });
});

describe("wrapLlmReviewError", () => {
  test("maps HTTP 429 to ANTHROPIC_RATE_LIMITED", () => {
    const raw = Object.assign(new Error("too many requests"), { status: 429 });
    const wrapped = wrapLlmReviewError(raw);
    expect(wrapped.code).toBe("ANTHROPIC_RATE_LIMITED");
    expect(wrapped.retryable).toBe(true);
  });

  test("maps schema mismatch message to ANTHROPIC_INVALID_TOOL_OUTPUT", () => {
    const raw = new Error("LLM returned a response that did not match the schema");
    const wrapped = wrapLlmReviewError(raw);
    expect(wrapped.code).toBe("ANTHROPIC_INVALID_TOOL_OUTPUT");
    expect(wrapped.retryable).toBe(false);
  });

  test("maps generic LLM errors to ANTHROPIC_INVALID_TOOL_OUTPUT", () => {
    const raw = new Error("unexpected model error");
    const wrapped = wrapLlmReviewError(raw);
    expect(wrapped.code).toBe("ANTHROPIC_INVALID_TOOL_OUTPUT");
  });

  test("passes an existing LlmReviewError through unchanged", () => {
    const existing = makeAnthropicRateLimitedError(null);
    const result = wrapLlmReviewError(existing);
    expect(result).toBe(existing);
  });
});

describe("wrapPostReviewError", () => {
  test("wraps any error into POST_REVIEW_FORBIDDEN", () => {
    const raw = Object.assign(new Error("403 Forbidden"), { status: 403 });
    const wrapped = wrapPostReviewError(raw);
    expect(wrapped.code).toBe("POST_REVIEW_FORBIDDEN");
    expect(wrapped.stage).toBe("post-review");
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.cause).toBe(raw);
  });

  test("passes an existing PostReviewError through unchanged", () => {
    const existing = makePostReviewForbiddenError(null);
    const result = wrapPostReviewError(existing);
    expect(result).toBe(existing);
  });
});

// ---------------------------------------------------------------------------
// logReviewError — smoke-test that it emits without throwing
// ---------------------------------------------------------------------------

describe("logReviewError", () => {
  test("emits without throwing for each stage", () => {
    const errors: ReviewError[] = [
      makeDiffFetchError(null),
      makeDiffTooLargeError(200_000, 150_000),
      makeJiraNotFoundError("PROJ-1", null),
      makeAnthropicRateLimitedError(null),
      makeAnthropicInvalidOutputError(null),
      makePostReviewForbiddenError(null),
    ];

    for (const err of errors) {
      expect(() =>
        logReviewError(err, { repo: "acme/widget", pr: 1 }),
      ).not.toThrow();
    }
  });

  test("includes evt, code, stage, retryable, repo, pr in the log payload", () => {
    const captured: string[] = [];
    const origError = console.error.bind(console);
    console.error = (line: string) => {
      captured.push(line);
    };

    try {
      const err = makeDiffFetchError(new Error("boom"));
      logReviewError(err, { repo: "acme/widget", pr: 7 });
    } finally {
      console.error = origError;
    }

    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!) as Record<string, unknown>;
    expect(parsed.evt).toBe("review.error");
    expect(parsed.code).toBe("GITHUB_DIFF_FETCH_FAILED");
    expect(parsed.stage).toBe("diff-fetch");
    expect(parsed.retryable).toBe(true);
    expect(parsed.repo).toBe("acme/widget");
    expect(parsed.pr).toBe(7);
  });
});
