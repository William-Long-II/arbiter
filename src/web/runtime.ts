/**
 * Shared state the web routes inspect. The loop writes to `status`; the server reads.
 * Decoupled so routes don't import the loop directly.
 */
import type { Breaker } from "../review/breaker.ts";

export type ActivePr = {
  /** "owner/name" of the repo this PR belongs to. */
  repo: string;
  /** PR number. */
  number: number;
  /** ISO timestamp of when processPr began for this PR. */
  startedAt: string;
};

export type Runtime = {
  startedAt: string;
  lastTickStart: string | null;
  lastTickEnd: string | null;
  lastTickError: string | null;
  /** ISO timestamp of when the loop intends to run the next tick. Null while a tick is in progress. */
  nextTickAt: string | null;
  /**
   * PRs currently being processed. Array because the loop can run multiple
   * workers concurrently (see review.concurrency). Empty when idle.
   * Workers push on entry, splice out on exit (in a finally) so a crash
   * inside processPr can't leave a ghost entry here.
   */
  currentPrs: ActivePr[];
  /** ISO of the most recent per-PR completion (any verdict). Updates throughout a long tick so "last activity" feels live. */
  lastActivityAt: string | null;
  bootstrappedFromYaml: boolean;
  /** Shared circuit breaker guarding Claude invocations. Single instance per process; all workers check it. */
  breaker: Breaker;
};

export function createRuntime(args: {
  bootstrappedFromYaml: boolean;
  breaker: Breaker;
}): Runtime {
  return {
    startedAt: new Date().toISOString(),
    lastTickStart: null,
    lastTickEnd: null,
    lastTickError: null,
    nextTickAt: null,
    currentPrs: [],
    lastActivityAt: null,
    bootstrappedFromYaml: args.bootstrappedFromYaml,
    breaker: args.breaker,
  };
}
