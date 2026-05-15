// Transient-failure retry policy. Pure (no I/O) so the classifier and the
// backoff curve unit-test without a worker or network. The worker applies
// these plus one economic guard it owns (don't auto-retry a multi-minute
// model timeout — that burns time and quota; see worker.ts).

/** Total attempts before a transient failure becomes a permanent `failed`.
 *  claimNext increments `attempt` on every claim, so 4 ⇒ up to 3 retries. */
export const MAX_ATTEMPTS = 4;

/**
 * Exponential backoff for the Nth attempt: 30s, 60s, 120s, 240s, … capped
 * at 10 minutes. `attempt` is the value claimNext stamped on the row
 * (1-based); anything ≤1 is treated as the first retry.
 */
export function retryDelaySeconds(attempt: number): number {
  const a = Math.max(1, Math.floor(attempt));
  return Math.min(600, 30 * 2 ** (a - 1));
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
]);

/**
 * Worth an automatic retry? True for the failures that are usually the
 * infrastructure's fault, not the PR's: GitHub 5xx, 408, 429, secondary
 * rate limits (403 + a rate-limit message), and socket-level network
 * errors. Everything else — 401/404/422, validation, our own logic — is
 * deterministic and would just fail again, so it stays a hard failure.
 */
export function isTransientError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    status?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };

  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status !== undefined) {
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    if (status === 403) {
      const m = typeof e.message === 'string' ? e.message.toLowerCase() : '';
      return m.includes('rate limit') || m.includes('secondary rate');
    }
    return false; // other 4xx are deterministic
  }

  const code = typeof e.code === 'string' ? e.code : '';
  if (NETWORK_CODES.has(code)) return true;
  if (typeof e.name === 'string' && e.name === 'FetchError') return true;
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return /fetch failed|socket hang ?up|connection reset|terminated|network error/.test(
    msg,
  );
}
