import type { ZodType } from "zod";

/**
 * Normalised usage shape that mirrors what `recordCacheTelemetry` expects.
 * Fields absent from the underlying API response are set to 0.
 */
export interface BackendUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/**
 * Input to a backend `parseReview` call.
 *
 * The `schema` field is a Zod schema whose inferred type is the expected
 * parsed output shape.  The backend is responsible for coercing the raw LLM
 * output into that shape (either via SDK helpers or manual JSON.parse +
 * schema.safeParse).
 */
export interface BackendInvokeRequest<T> {
  /** System prompt text. */
  system: string;
  /** User message text. */
  userMessage: string;
  /** Zod schema used to validate the parsed output. */
  schema: ZodType<T>;
  /** Model identifier string (e.g. "claude-opus-4-7"). */
  model: string;
  /** Maximum tokens to generate. */
  maxTokens: number;
  /** Optional repo slug for telemetry / fallback log context. */
  repo?: string;
  /** Optional PR number for telemetry / fallback log context. */
  pr?: number;
}

/**
 * Result returned by a backend `parseReview` call.
 *
 * `parsedOutput` is always present — on hard failures the backend returns a
 * safe fallback object rather than throwing.
 */
export interface BackendInvokeResult<T> {
  parsedOutput: T;
  usage: BackendUsage;
  /** Raw LLM output string, when available (useful for audit records). */
  raw?: string;
}

/**
 * Common interface implemented by every LLM backend.
 *
 * Implementations must not throw on schema validation failures; they should
 * return a graceful fallback `parsedOutput` instead and emit a warn log.
 */
export interface ReviewBackend {
  parseReview<T>(
    request: BackendInvokeRequest<T>,
  ): Promise<BackendInvokeResult<T>>;
}
