import { describe, expect, test } from "bun:test";
import { Breaker, type BreakerTransition } from "../src/review/breaker.ts";

function makeBreaker(opts: Partial<{ threshold: number; cooldownMs: number; now: () => number }> = {}) {
  const transitions: BreakerTransition[] = [];
  const time = { value: 0 };
  const b = new Breaker({
    threshold: opts.threshold ?? 3,
    cooldownMs: opts.cooldownMs ?? 60_000,
    now: opts.now ?? (() => time.value),
    onTransition: (t) => transitions.push(t),
  });
  return { b, transitions, time };
}

describe("Breaker state machine", () => {
  test("starts closed, permits acquires", () => {
    const { b } = makeBreaker();
    expect(b.inspect().kind).toBe("closed");
    const a = b.tryAcquire();
    expect(a.allowed).toBe(true);
    if (a.allowed) expect(a.trial).toBe(false);
  });

  test("records failures up to but not past the threshold while closed", () => {
    const { b } = makeBreaker({ threshold: 3 });
    b.recordFailure("first");
    b.recordFailure("second");
    expect(b.inspect().kind).toBe("closed");
    if (b.inspect().kind === "closed") {
      expect((b.inspect() as { consecutiveFailures: number }).consecutiveFailures).toBe(2);
    }
  });

  test("opens exactly at threshold", () => {
    const { b, transitions } = makeBreaker({ threshold: 3 });
    b.recordFailure("1");
    b.recordFailure("2");
    b.recordFailure("3");
    expect(b.inspect().kind).toBe("open");
    expect(transitions).toEqual([{ from: "closed", to: "open", reason: "threshold 3 reached" }]);
  });

  test("open refuses acquires until cooldown elapses", () => {
    const { b, time } = makeBreaker({ threshold: 1, cooldownMs: 60_000 });
    time.value = 0;
    b.recordFailure("boom");
    expect(b.inspect().kind).toBe("open");

    const a1 = b.tryAcquire();
    expect(a1.allowed).toBe(false);
    if (!a1.allowed) expect(a1.reopensAt).toBe(60_000);

    time.value = 59_999;
    expect(b.tryAcquire().allowed).toBe(false);

    time.value = 60_000;
    const a2 = b.tryAcquire();
    expect(a2.allowed).toBe(true);
    if (a2.allowed) expect(a2.trial).toBe(true);
  });

  test("half_open trial success closes the breaker", () => {
    const { b, transitions, time } = makeBreaker({ threshold: 1, cooldownMs: 1000 });
    b.recordFailure("x");
    time.value = 2000;
    const a = b.tryAcquire(); // transitions to half_open
    expect(a.allowed).toBe(true);
    expect(b.inspect().kind).toBe("half_open");

    b.recordSuccess();
    expect(b.inspect().kind).toBe("closed");
    expect(transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      "closed->open",
      "open->half_open",
      "half_open->closed",
    ]);
  });

  test("half_open trial failure reopens with a fresh cooldown", () => {
    const { b, transitions, time } = makeBreaker({ threshold: 1, cooldownMs: 1000 });
    b.recordFailure("first");
    time.value = 1000;
    b.tryAcquire(); // -> half_open
    b.recordFailure("trial-failed");
    const state = b.inspect();
    expect(state.kind).toBe("open");
    // fresh cooldown from time 1000 + 1000
    if (state.kind === "open") expect(state.reopensAt).toBe(2000);
    expect(transitions.filter((t) => t.to === "open").length).toBe(2);
  });

  test("success while closed resets the consecutive-failure counter", () => {
    const { b } = makeBreaker({ threshold: 5 });
    b.recordFailure("a");
    b.recordFailure("b");
    b.recordFailure("c");
    b.recordFailure("d");
    // one shy of the threshold
    const s = b.inspect();
    if (s.kind === "closed") expect(s.consecutiveFailures).toBe(4);
    b.recordSuccess();
    // another 4 failures should NOT now trip the breaker (counter reset)
    b.recordFailure("a");
    b.recordFailure("b");
    b.recordFailure("c");
    b.recordFailure("d");
    expect(b.inspect().kind).toBe("closed");
  });

  test("extra failures while open extend the cooldown but don't emit spurious transitions", () => {
    const { b, transitions, time } = makeBreaker({ threshold: 1, cooldownMs: 10_000 });
    time.value = 0;
    b.recordFailure("boom");
    expect(b.inspect().kind).toBe("open");
    time.value = 5000;
    b.recordFailure("another");
    const s = b.inspect();
    expect(s.kind).toBe("open");
    if (s.kind === "open") expect(s.reopensAt).toBe(15_000); // 5000 + cooldown
    // only one transition: closed->open
    expect(transitions).toHaveLength(1);
  });

  test("threshold below 1 is clamped to 1", () => {
    const { b } = makeBreaker({ threshold: 0 });
    b.recordFailure("oops");
    expect(b.inspect().kind).toBe("open");
  });

  test("cooldownMs below 1000 is clamped to 1000", () => {
    const { b, time } = makeBreaker({ threshold: 1, cooldownMs: 50 });
    b.recordFailure("x");
    time.value = 999;
    expect(b.tryAcquire().allowed).toBe(false);
    time.value = 1000;
    expect(b.tryAcquire().allowed).toBe(true);
  });
});
