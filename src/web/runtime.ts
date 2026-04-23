/**
 * Shared state the web routes inspect. The loop writes to `status`; the server reads.
 * Decoupled so routes don't import the loop directly.
 */
import type { Breaker } from "../review/breaker.ts";

/**
 * A PR nominated for immediate processing by the webhook ingest path.
 * The main loop drains `runtime.webhookQueue` at the start of every tick
 * and merges the entries into the normal eligibility list. Dedupe still
 * applies: if the loop already reviewed this SHA (via polling), the queue
 * entry is a cheap no-op.
 */
export type WebhookPullRef = {
  repo: { owner: string; name: string };
  number: number;
  head_sha: string;
  /** Freeform source tag, used in events for observability. */
  source: "webhook";
};

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
  /**
   * PRs queued for immediate review by the webhook ingest path. The main
   * loop drains this at the top of every tick. Pushing here is cheap; the
   * payload is small and the queue only grows if webhooks arrive faster
   * than the loop can drain, which would be a separate problem.
   */
  webhookQueue: WebhookPullRef[];
  /**
   * Set by the webhook handler when it enqueues a PR. The main loop's
   * sleep wrapper observes this to shorten the current interval — turning
   * "60s polling" into "instant response" without blowing up the idle-wait
   * design.
   */
  wakeRequested: boolean;
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
    webhookQueue: [],
    wakeRequested: false,
  };
}
