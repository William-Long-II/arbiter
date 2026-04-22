/**
 * Shared state the web routes inspect. The loop writes to `status`; the server reads.
 * Decoupled so routes don't import the loop directly.
 */
export type Runtime = {
  startedAt: string;
  lastTickStart: string | null;
  lastTickEnd: string | null;
  lastTickError: string | null;
  /** ISO timestamp of when the loop intends to run the next tick. Null while a tick is in progress. */
  nextTickAt: string | null;
  /** While processing a PR, the slug of that repo ("owner/name"); null when idle between PRs. */
  currentRepo: string | null;
  /** PR number currently being processed; null when idle between PRs. */
  currentPrNumber: number | null;
  /** ISO timestamp of when the current PR started processing. Null when idle. */
  currentPrStartedAt: string | null;
  /** ISO timestamp of the most recent per-PR completion (any verdict). Updates throughout a long tick so "last activity" feels live. */
  lastActivityAt: string | null;
  bootstrappedFromYaml: boolean;
};

export function createRuntime(bootstrappedFromYaml: boolean): Runtime {
  return {
    startedAt: new Date().toISOString(),
    lastTickStart: null,
    lastTickEnd: null,
    lastTickError: null,
    nextTickAt: null,
    currentRepo: null,
    currentPrNumber: null,
    currentPrStartedAt: null,
    lastActivityAt: null,
    bootstrappedFromYaml,
  };
}
