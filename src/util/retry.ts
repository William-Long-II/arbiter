/**
 * Exponential backoff with full jitter and Retry-After support.
 *
 * Non-retryable by default: any 4xx except 408 (Request Timeout) and 429
 * (Too Many Requests).  Callers can supply a custom `retryOn` predicate to
 * override or extend this.
 */

export type RetryOptions = {
  /** Maximum number of attempts (first call + retries). Default: 3. */
  attempts?: number;
  /** Base delay in ms before jitter. Default: 200. */
  baseMs?: number;
  /** Cap on computed delay before jitter. Default: 30_000. */
  capMs?: number;
  /** Only "full" jitter is supported today — pick uniformly in [0, capped]. */
  jitter?: "full";
  /**
   * Return true to retry the error.  Default behaviour: retry on network
   * errors (no status) and on 408 / 429 / 5xx.
   */
  retryOn?: (err: unknown) => boolean;
};

/**
 * Extract an HTTP status from whatever the client libraries throw.
 * Octokit, Anthropic SDK, and the hand-rolled Jira fetch all surface it
 * differently but consistently use a numeric `status` property.
 */
function extractStatus(err: unknown): number | undefined {
  if (err != null && typeof err === "object") {
    const s = (err as Record<string, unknown>).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

/**
 * Extract the value of a `Retry-After` header (in seconds) from an error
 * thrown by the client libraries.  Anthropic and Octokit both attach a
 * `headers` object to their error instances.
 */
function extractRetryAfterMs(err: unknown): number | undefined {
  if (err == null || typeof err !== "object") return undefined;
  const headers = (err as Record<string, unknown>).headers;
  if (headers == null || typeof headers !== "object") return undefined;
  const raw =
    (headers as Record<string, unknown>)["retry-after"] ??
    (headers as Record<string, unknown>)["Retry-After"];
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
}

export function defaultRetryOn(err: unknown): boolean {
  const status = extractStatus(err);
  if (status === undefined) {
    // No HTTP status — treat as a network/transport error, always retry.
    return true;
  }
  // 408 Request Timeout, 429 Too Many Requests, and all 5xx are retryable.
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  // All other 4xx are client errors (bad request, auth failure, not found…) —
  // retrying will not help.
  return false;
}

/**
 * Run `fn` up to `attempts` times, retrying on transient failures with
 * exponential backoff + full jitter.  Honours `Retry-After` on 429s.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    attempts = 3,
    baseMs = 200,
    capMs = 30_000,
    retryOn = defaultRetryOn,
  } = options;

  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      const isLast = attempt === attempts - 1;
      if (isLast || !retryOn(err)) {
        throw err;
      }

      // Honour Retry-After when present (typically on 429).
      const retryAfterMs = extractRetryAfterMs(err);
      let delayMs: number;
      if (retryAfterMs !== undefined) {
        delayMs = retryAfterMs;
      } else {
        // Full-jitter exponential backoff: pick uniformly in [0, min(cap, base * 2^attempt)].
        const ceiling = Math.min(capMs, baseMs * Math.pow(2, attempt));
        delayMs = Math.random() * ceiling;
      }

      await sleep(delayMs);
    }
  }

  // Unreachable in practice (loop always throws or returns), but TypeScript
  // needs a definite return path.
  throw lastErr;
}

/** Replaceable in tests via module-level assignment. */
export let sleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Allow tests to swap the sleep implementation without monkey-patching. */
export function setSleep(impl: (ms: number) => Promise<void>): void {
  sleep = impl;
}
