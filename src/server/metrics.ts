/**
 * Minimal Prometheus text-format registry.
 *
 * No external dependency — implements only the subset of the Prometheus
 * exposition format needed by this project:
 *   https://prometheus.io/docs/instrumenting/exposition_formats/
 *
 * Primitives:
 *   Counter   — monotonically increasing value; labels are static key/value pairs.
 *   Histogram — samples observations into configurable buckets; exposes _bucket,
 *               _sum, and _count series.
 *
 * Label cardinality guard: any metric that already has MAX_LABEL_VALUES distinct
 * label-set combinations will refuse new ones and log a warning. This prevents
 * accidental cardinality explosions from unbounded label values (e.g. commit SHAs).
 */

import { log } from "./logger.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on distinct label-value combinations per metric. */
const MAX_LABEL_VALUES = 1_000;

/**
 * Default histogram bucket boundaries (seconds). Suitable for operations that
 * take up to ~60 seconds. Covers sub-millisecond CI-wait and multi-second LLM
 * round-trips in the same histogram.
 */
const DEFAULT_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
];

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type LabelSet = Record<string, string>;

interface CounterState {
  value: number;
}

interface HistogramState {
  sum: number;
  count: number;
  buckets: Map<number, number>; // upper_bound -> cumulative count
}

interface MetricEntry<T> {
  help: string;
  type: "counter" | "histogram";
  bucketBounds?: readonly number[]; // histogram only
  series: Map<string, T>; // serialisedLabels -> state
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

class Registry {
  private readonly counters = new Map<string, MetricEntry<CounterState>>();
  private readonly histograms = new Map<
    string,
    MetricEntry<HistogramState>
  >();

  registerCounter(name: string, help: string): void {
    if (!this.counters.has(name)) {
      this.counters.set(name, { help, type: "counter", series: new Map() });
    }
  }

  registerHistogram(
    name: string,
    help: string,
    buckets: readonly number[] = DEFAULT_BUCKETS,
  ): void {
    if (!this.histograms.has(name)) {
      this.histograms.set(name, {
        help,
        type: "histogram",
        bucketBounds: [...buckets].sort((a, b) => a - b),
        series: new Map(),
      });
    }
  }

  incrementCounter(name: string, labels: LabelSet = {}, amount = 1): void {
    const entry = this.counters.get(name);
    if (!entry) throw new Error(`Counter not registered: ${name}`);
    const key = serialiseLabels(labels);
    let state = entry.series.get(key);
    if (!state) {
      if (entry.series.size >= MAX_LABEL_VALUES) {
        log.warn("metrics: label cardinality cap reached, dropping increment", {
          metric: name,
          labels,
          cap: MAX_LABEL_VALUES,
        });
        return;
      }
      state = { value: 0 };
      entry.series.set(key, state);
    }
    state.value += amount;
  }

  observeHistogram(name: string, value: number, labels: LabelSet = {}): void {
    const entry = this.histograms.get(name);
    if (!entry) throw new Error(`Histogram not registered: ${name}`);
    const key = serialiseLabels(labels);
    let state = entry.series.get(key);
    if (!state) {
      if (entry.series.size >= MAX_LABEL_VALUES) {
        log.warn(
          "metrics: label cardinality cap reached, dropping observation",
          { metric: name, labels, cap: MAX_LABEL_VALUES },
        );
        return;
      }
      // Initialise bucket map with 0 counts for every bound plus +Inf.
      const bucketMap = new Map<number, number>();
      for (const b of entry.bucketBounds ?? DEFAULT_BUCKETS) {
        bucketMap.set(b, 0);
      }
      bucketMap.set(Infinity, 0);
      state = { sum: 0, count: 0, buckets: bucketMap };
      entry.series.set(key, state);
    }
    state.sum += value;
    state.count += 1;
    for (const [bound] of state.buckets) {
      if (value <= bound) {
        state.buckets.set(bound, (state.buckets.get(bound) ?? 0) + 1);
      }
    }
  }

  /** Serialise everything as Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];

    for (const [name, entry] of this.counters) {
      lines.push(`# HELP ${name} ${escapeHelp(entry.help)}`);
      lines.push(`# TYPE ${name} counter`);
      for (const [labelStr, state] of entry.series) {
        lines.push(
          `${name}${labelStr ? `{${labelStr}}` : ""} ${state.value}`,
        );
      }
    }

    for (const [name, entry] of this.histograms) {
      lines.push(`# HELP ${name} ${escapeHelp(entry.help)}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const [labelStr, state] of entry.series) {
        const prefix = labelStr ? `{${labelStr},` : "{";
        for (const [bound, count] of state.buckets) {
          const leLabel =
            bound === Infinity ? '+Inf' : String(bound);
          const fullLabel = `${prefix}le="${leLabel}"}`;
          lines.push(`${name}_bucket${fullLabel} ${count}`);
        }
        const labelSuffix = labelStr ? `{${labelStr}}` : "";
        lines.push(`${name}_sum${labelSuffix} ${state.sum}`);
        lines.push(`${name}_count${labelSuffix} ${state.count}`);
      }
    }

    return lines.join("\n") + (lines.length > 0 ? "\n" : "");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable serialisation of a label set to a Prometheus label-string fragment. */
function serialiseLabels(labels: LabelSet): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}="${escapeLabel(labels[k] ?? "")}"`).join(",");
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHelp(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

// ---------------------------------------------------------------------------
// Singleton registry + named metrics
// ---------------------------------------------------------------------------

export const registry = new Registry();

// --- Counters ---

/** Config reload attempts, labelled by result (success/failure). */
export const configReloadTotal = "reviewme_config_reload_total";
registry.registerCounter(
  configReloadTotal,
  "Total number of SIGHUP-triggered config reloads, by result (success/failure).",
);

/** Total webhooks received, labelled by GitHub event name. */
export const webhookReceived = "reviewme_webhook_received_total";
registry.registerCounter(
  webhookReceived,
  "Total number of webhook deliveries received, by GitHub event type.",
);

/** Completed reviews, labelled by repo slug and verdict (approve/comment). */
export const reviewsTotal = "reviewme_reviews_total";
registry.registerCounter(
  reviewsTotal,
  "Total number of completed PR reviews, by repo and verdict.",
);

/** Review pipeline failures, labelled by stage and reason. */
export const reviewFailures = "reviewme_review_failures_total";
registry.registerCounter(
  reviewFailures,
  "Total review pipeline failures, by stage and reason.",
);

/** Anthropic token usage, labelled by kind (input/output/cache_read/cache_write). */
export const anthropicTokens = "reviewme_anthropic_tokens_total";
registry.registerCounter(
  anthropicTokens,
  "Total Anthropic API tokens consumed, by kind (input/output/cache_read/cache_write).",
);

/** Webhook requests rejected by the per-installation rate limiter. */
export const ratelimitRejected = "reviewme_ratelimit_rejected_total";
registry.registerCounter(
  ratelimitRejected,
  "Total webhook requests rejected by the per-installation rate limiter.",
);

/** Thread replies posted (or errored), labelled by outcome (sent/error). */
export const threadReplyTotal = "reviewme_thread_reply_total";
registry.registerCounter(
  threadReplyTotal,
  "Total thread reply attempts, by outcome (sent/error).",
);

/** Threads rate-limited (exceeded per-thread reply cap). */
export const threadRateLimitedTotal = "reviewme_thread_rate_limited_total";
registry.registerCounter(
  threadRateLimitedTotal,
  "Total thread replies suppressed by the per-thread rate limit.",
);

/** PRs skipped because they were in draft state. */
export const draftSkippedTotal = "reviewme_draft_skipped_total";
registry.registerCounter(
  draftSkippedTotal,
  "Total PR events skipped because the pull request was in draft state.",
);

// --- Histograms ---

/** Seconds spent draining in-flight tasks on SIGTERM before process.exit(). */
export const shutdownDrainSeconds = "reviewme_shutdown_drain_seconds";
registry.registerHistogram(
  shutdownDrainSeconds,
  "Seconds elapsed draining in-flight tasks during graceful shutdown.",
);

/** End-to-end review duration in seconds. */
export const reviewDuration = "reviewme_review_duration_seconds";
registry.registerHistogram(
  reviewDuration,
  "End-to-end review pipeline duration in seconds.",
);

/** Time spent waiting for CI to go green (seconds). */
export const ciWaitSeconds = "reviewme_ci_wait_seconds";
registry.registerHistogram(
  ciWaitSeconds,
  "Seconds elapsed waiting for CI gate to pass.",
);

/** Slash commands processed, labelled by command name. */
export const slashCommandTotal = "reviewme_slash_command_total";
registry.registerCounter(
  slashCommandTotal,
  "Total slash commands processed, by command name (help/skip/resume/re-review/unknown).",
);

// --- Coverage signal counter ---

/**
 * Test-coverage signal bucket per review.
 *
 * bucket values:
 *   no_new_src — diff had no net-new source lines (no signal to inject)
 *   has_tests  — source lines were added and at least some test lines too
 *   untested   — source lines were added but zero test lines
 */
export const coverageSignalTotal = "reviewme_coverage_signal_total";
registry.registerCounter(
  coverageSignalTotal,
  "Total PR reviews by test-coverage signal bucket (no_new_src/has_tests/untested).",
);

/** Circuit breaker state gauge (0=closed, 1=open, 2=half-open), labelled by dep. */
export const breakerState = "reviewme_breaker_state";
registry.registerCounter(
  breakerState,
  "Current circuit breaker state by dependency (0=closed, 1=open, 2=half-open).",
);

/** Webhook deliveries that verified successfully, labelled by secret slot (primary/secondary). */
export const webhookSecretUsedTotal = "reviewme_webhook_secret_used_total";
registry.registerCounter(
  webhookSecretUsedTotal,
  "Total webhook deliveries verified successfully, by secret slot (primary/secondary).",
);

/** Budget-exhausted reviews, labelled by repo slug. */
export const budgetExhaustedTotal = "reviewme_budget_exhausted_total";
registry.registerCounter(
  budgetExhaustedTotal,
  "Total reviews skipped because the repo's weekly token budget was exhausted.",
);

// --- Result cache counters ---

/** Review result cache hits and misses, labelled by result (hit/miss). */
export const reviewCacheTotal = "reviewme_review_cache_total";
registry.registerCounter(
  reviewCacheTotal,
  "Total review result cache lookups, by result (hit/miss).",
);

// --- Replay-protection counters ---

/** Webhook deliveries rejected as replays (duplicate delivery ID). */
export const webhookReplayTotal = "reviewme_webhook_replay_total";
registry.registerCounter(
  webhookReplayTotal,
  "Total webhook deliveries rejected as replays (duplicate delivery ID within TTL).",
);

/** Webhook deliveries rejected because the event name is not recognised. */
export const webhookUnknownEventTotal = "reviewme_webhook_unknown_event_total";
registry.registerCounter(
  webhookUnknownEventTotal,
  "Total webhook deliveries rejected because the X-GitHub-Event is not handled.",
);

// ---------------------------------------------------------------------------
// Convenience wrappers used by instrumented call-sites
// ---------------------------------------------------------------------------

export function incWebhookReceived(event: string): void {
  registry.incrementCounter(webhookReceived, { event });
}

export function incReviewsTotal(repo: string, verdict: string): void {
  registry.incrementCounter(reviewsTotal, { repo, verdict });
}

export function incReviewFailures(stage: string, reason: string): void {
  registry.incrementCounter(reviewFailures, { stage, reason });
}

export function incAnthropicTokens(kind: string, amount: number): void {
  registry.incrementCounter(anthropicTokens, { kind }, amount);
}

export function observeReviewDuration(seconds: number): void {
  registry.observeHistogram(reviewDuration, seconds);
}

export function observeCiWaitSeconds(seconds: number): void {
  registry.observeHistogram(ciWaitSeconds, seconds);
}

export function incCoverageSignal(
  bucket: "no_new_src" | "has_tests" | "untested",
): void {
  registry.incrementCounter(coverageSignalTotal, { bucket });
}

export function incWebhookSecretUsed(slot: "primary" | "secondary"): void {
  registry.incrementCounter(webhookSecretUsedTotal, { slot });
}

export function incWebhookReplay(): void {
  registry.incrementCounter(webhookReplayTotal, {});
}

export function incWebhookUnknownEvent(event: string): void {
  registry.incrementCounter(webhookUnknownEventTotal, { event });
}

export function incConfigReload(result: "success" | "failure"): void {
  registry.incrementCounter(configReloadTotal, { result });
}

export function incRatelimitRejected(installation: string): void {
  registry.incrementCounter(ratelimitRejected, { installation });
}

export function observeShutdownDrain(seconds: number): void {
  registry.observeHistogram(shutdownDrainSeconds, seconds);
}

export function incThreadReply(outcome: "sent" | "error"): void {
  registry.incrementCounter(threadReplyTotal, { outcome });
}

export function incThreadRateLimited(): void {
  registry.incrementCounter(threadRateLimitedTotal);
}

/**
 * Record the current circuit-breaker state for `dep`.
 *
 * The metrics registry only has Counter (monotonic). We simulate a gauge by
 * directly setting the counter value — valid here because breaker state is a
 * small bounded enum value (0, 1, or 2), not a rate, and the semantics of
 * "latest wins" match what operators need for alerting on open breakers.
 */
export function setBreakerState(dep: string, value: number): void {
  const entry = (
    registry as unknown as {
      counters: Map<string, { series: Map<string, { value: number }> }>;
    }
  ).counters.get(breakerState);
  if (!entry) return;
  const key = `dep="${dep}"`;
  let state = entry.series.get(key);
  if (!state) {
    state = { value: 0 };
    entry.series.set(key, state);
  }
  state.value = value;
}

export function incDraftSkipped(): void {
  registry.incrementCounter(draftSkippedTotal);
}

export function incBudgetExhausted(repo: string): void {
  registry.incrementCounter(budgetExhaustedTotal, { repo });
}

export function incReviewCache(result: "hit" | "miss"): void {
  registry.incrementCounter(reviewCacheTotal, { result });
}

export function incSlashCommand(
  command: "help" | "skip" | "resume" | "re-review" | "unknown",
): void {
  registry.incrementCounter(slashCommandTotal, { command });
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/**
 * Build the GET /metrics route handler.
 *
 * If `METRICS_BIND_TOKEN` is set in the environment, every request must carry
 * an `Authorization: Bearer <token>` header matching that value. Requests
 * without the header or with a wrong token receive 401.
 *
 * Returns `null` when metrics should not be exposed (should not happen in
 * practice — the route simply won't be registered if this returns null).
 */
export function buildMetricsHandler(): (
  req: Request,
) => Response | Promise<Response> {
  const token = process.env["METRICS_BIND_TOKEN"] ?? null;

  return (req: Request): Response => {
    if (token !== null) {
      const authHeader = req.headers.get("authorization") ?? "";
      const match = authHeader.match(/^Bearer (.+)$/i);
      if (!match || match[1] !== token) {
        return new Response("unauthorized", { status: 401 });
      }
    }
    const body = registry.render();
    return new Response(body, {
      status: 200,
      headers: {
        "content-type":
          "text/plain; version=0.0.4; charset=utf-8",
      },
    });
  };
}
