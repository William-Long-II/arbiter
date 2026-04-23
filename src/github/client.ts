import { Octokit } from "@octokit/rest";

/**
 * What we extract from every GitHub API response for rate-limit
 * visibility. Observed on the dashboard so an operator can see
 * "oh, we're burning through the quota" before the PAT gets 403'd.
 *
 * Values come from the X-RateLimit-{Remaining,Limit,Reset} headers
 * that every REST call returns. Kept in the Runtime so the UI and
 * /api/status can read the latest without extra API calls.
 */
export type GhRateLimit = {
  /** Remaining requests in the current window. */
  remaining: number;
  /** Total requests allowed in the window (5000 for PATs, 1000 for unauth). */
  limit: number;
  /** Unix-seconds timestamp at which the window resets. */
  resetAt: number;
  /** ISO timestamp of when these numbers were observed. */
  observedAt: string;
};

export type MakeClientOpts = {
  /**
   * Fires after every successful GitHub API response with the extracted
   * rate-limit headers. Called synchronously inside Octokit's `after`
   * hook, so keep the implementation fast — the main loop is blocked
   * on it. Ignored if the response doesn't include the headers (which
   * happens for e.g. the GraphQL endpoint on older Octokit versions).
   */
  onRateLimit?: (limit: GhRateLimit) => void;
};

export function makeClient(token: string, opts: MakeClientOpts = {}): Octokit {
  const gh = new Octokit({
    auth: token,
    userAgent: "auto-reviewer",
    request: { timeout: 30_000 },
  });

  if (opts.onRateLimit) {
    const onRateLimit = opts.onRateLimit;
    // Octokit fires the "after" hook after every successful request
    // (4xx/5xx error responses take the onError path; we don't read
    // rate limits from those). We rely on the standard x-ratelimit-*
    // header set.
    gh.hook.after("request", (response) => {
      const parsed = parseRateLimitHeaders(response.headers ?? {});
      if (parsed) onRateLimit(parsed);
    });
  }

  return gh;
}

/**
 * Pure header-to-GhRateLimit parser. Exported so the behavior can be
 * unit-tested without mocking Octokit's request pipeline. Returns null
 * when any of the three headers is missing or unparseable — the caller
 * then treats the observation as "nothing new to report."
 */
export function parseRateLimitHeaders(headers: Record<string, unknown>): GhRateLimit | null {
  const remaining = toInt(headers["x-ratelimit-remaining"]);
  const limit = toInt(headers["x-ratelimit-limit"]);
  const resetAt = toInt(headers["x-ratelimit-reset"]);
  if (remaining === null || limit === null || resetAt === null) return null;
  return {
    remaining,
    limit,
    resetAt,
    observedAt: new Date().toISOString(),
  };
}

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export type GH = Octokit;
