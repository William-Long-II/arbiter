/**
 * Circuit breaker for Claude invocations.
 *
 * The loop retries every PR every tick. When Claude is broken — rate-limited,
 * Max session expired, host lost network — each retry burns another
 * invocation and amplifies whatever's wrong. The breaker puts a hard stop
 * in front of the retry loop:
 *
 *   closed:    normal operation; count consecutive failures; trip at threshold
 *   open:      refuse all calls for `cooldownMs`; next acquire after that is half-open
 *   half_open: one trial call is permitted; success closes the breaker,
 *              failure reopens it for another cooldown
 *
 * A success in ANY state resets the consecutive-failure counter to zero.
 * The breaker lives in memory; state is lost across restarts (intentional —
 * a fresh start should try Claude fresh).
 */

export type BreakerState =
  | { kind: "closed"; consecutiveFailures: number }
  | { kind: "open"; reopensAt: number; lastReason: string }
  | { kind: "half_open" };

export type BreakerTransition = {
  from: BreakerState["kind"];
  to: BreakerState["kind"];
  reason?: string;
};

export type BreakerConfig = {
  threshold: number;
  cooldownMs: number;
  onTransition?: (t: BreakerTransition) => void;
  /** Pluggable for tests. */
  now?: () => number;
};

export type Acquire =
  | { allowed: true; trial: boolean }
  | { allowed: false; reopensAt: number; lastReason: string };

export class Breaker {
  private state: BreakerState = { kind: "closed", consecutiveFailures: 0 };
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly onTransition: (t: BreakerTransition) => void;
  private readonly now: () => number;

  constructor(cfg: BreakerConfig) {
    this.threshold = Math.max(1, cfg.threshold);
    this.cooldownMs = Math.max(1_000, cfg.cooldownMs);
    this.onTransition = cfg.onTransition ?? (() => {});
    this.now = cfg.now ?? Date.now;
  }

  /**
   * Called before attempting a Claude invocation. Returns whether the call is
   * allowed, and whether it's the half-open trial (the caller may want to log
   * differently — a trial failure reopens the breaker, not just increments).
   */
  tryAcquire(): Acquire {
    if (this.state.kind === "closed") return { allowed: true, trial: false };
    if (this.state.kind === "half_open") return { allowed: true, trial: true };
    // open — cooldown elapsed? transition to half_open and allow this call
    if (this.now() >= this.state.reopensAt) {
      const reason = this.state.lastReason;
      this.transition({ kind: "half_open" }, "open", "half_open", "cooldown elapsed");
      return { allowed: true, trial: true };
    }
    return {
      allowed: false,
      reopensAt: this.state.reopensAt,
      lastReason: this.state.lastReason,
    };
  }

  recordSuccess(): void {
    const from = this.state.kind;
    if (from !== "closed") {
      this.transition(
        { kind: "closed", consecutiveFailures: 0 },
        from,
        "closed",
        "trial succeeded",
      );
      return;
    }
    // Already closed; any success resets the counter (partial-win through a
    // streak of failures shouldn't leave us at the edge of the threshold).
    if (this.state.consecutiveFailures > 0) {
      this.state = { kind: "closed", consecutiveFailures: 0 };
    }
  }

  recordFailure(reason: string): void {
    if (this.state.kind === "half_open") {
      this.transition(
        {
          kind: "open",
          reopensAt: this.now() + this.cooldownMs,
          lastReason: reason,
        },
        "half_open",
        "open",
        "trial failed: " + reason,
      );
      return;
    }
    if (this.state.kind === "open") {
      // Shouldn't happen — open refuses acquires — but a concurrent worker
      // could race us. Harmless; extend the cooldown.
      this.state = {
        kind: "open",
        reopensAt: this.now() + this.cooldownMs,
        lastReason: reason,
      };
      return;
    }
    // closed
    const next = this.state.consecutiveFailures + 1;
    if (next >= this.threshold) {
      this.transition(
        {
          kind: "open",
          reopensAt: this.now() + this.cooldownMs,
          lastReason: reason,
        },
        "closed",
        "open",
        `threshold ${this.threshold} reached`,
      );
    } else {
      this.state = { kind: "closed", consecutiveFailures: next };
    }
  }

  inspect(): BreakerState {
    return this.state;
  }

  private transition(
    next: BreakerState,
    from: BreakerState["kind"],
    to: BreakerState["kind"],
    reason?: string,
  ): void {
    this.state = next;
    this.onTransition({ from, to, reason });
  }
}
