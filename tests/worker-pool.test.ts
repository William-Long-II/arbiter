import { describe, expect, test } from 'bun:test';
import { createWorkerPool } from '../src/worker-pool.ts';

// A deferred we can resolve from the test to control when a `run` settles.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('createWorkerPool', () => {
  test('drains a backlog and never exceeds concurrency', async () => {
    const total = 50;
    const queue = Array.from({ length: total }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;
    const processed: number[] = [];

    const pool = createWorkerPool<number>({
      concurrency: 4,
      claim: async () => (queue.length ? queue.shift()! : null),
      run: async (job) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick();
        processed.push(job);
        inFlight--;
      },
    });

    pool.pump();
    while (processed.length < total) await tick();

    expect(processed.length).toBe(total);
    expect(new Set(processed).size).toBe(total); // each claimed exactly once
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBe(4); // it actually used the full width
    expect(pool.active).toBe(0);
  });

  test('saturates at concurrency; extra pumps while full are no-ops', async () => {
    const gates = [deferred(), deferred(), deferred()];
    let claimed = 0;
    const pool = createWorkerPool<number>({
      concurrency: 2,
      claim: async () => (claimed < gates.length ? claimed++ : null),
      run: async (job) => {
        await gates[job]!.promise;
      },
    });

    pool.pump();
    await tick();
    expect(pool.active).toBe(2); // only 2 of 3 running

    pool.pump();
    pool.pump(); // hammering while saturated must not oversubscribe
    await tick();
    expect(pool.active).toBe(2);
    expect(claimed).toBe(2); // the 3rd job was never claimed yet

    gates[0]!.resolve(); // free one slot → the 3rd job is picked up
    await tick();
    expect(claimed).toBe(3);
    expect(pool.active).toBe(2);

    gates[1]!.resolve();
    gates[2]!.resolve();
    while (pool.active > 0) await tick();
    expect(pool.active).toBe(0);
  });

  test('a finished job re-pumps so later-arriving work is picked up', async () => {
    let supply = 2;
    const processed: number[] = [];
    const pool = createWorkerPool<number>({
      concurrency: 1,
      claim: async () => (supply > 0 ? (supply--, processed.length) : null),
      run: async (job) => {
        processed.push(job);
        await tick();
      },
    });

    pool.pump();
    while (processed.length < 2) await tick();
    expect(processed).toEqual([0, 1]); // serialized at concurrency 1

    // Queue drained; pool is idle. New work + a wake pump must resume.
    supply = 1;
    pool.pump();
    while (processed.length < 3) await tick();
    expect(processed).toEqual([0, 1, 2]);
  });

  test('claim error backs off; a later pump resumes cleanly', async () => {
    let mode: 'throw' | 'serve' = 'throw';
    const claimErrors: unknown[] = [];
    let served = false;
    const pool = createWorkerPool<string>({
      concurrency: 2,
      claim: async () => {
        if (mode === 'throw') throw new Error('db down');
        if (served) return null;
        served = true;
        return 'job';
      },
      run: async () => {},
      onClaimError: (e) => claimErrors.push(e),
    });

    pool.pump();
    await tick();
    expect(claimErrors.length).toBeGreaterThan(0);
    expect(pool.active).toBe(0); // reservation released on claim failure

    mode = 'serve';
    pool.pump();
    await tick();
    expect(served).toBe(true);
    expect(pool.active).toBe(0);
  });

  test('a rejected run frees the slot and the pool keeps going', async () => {
    const queue = [1, 2, 3];
    const runErrors: unknown[] = [];
    const ok: number[] = [];
    const pool = createWorkerPool<number>({
      concurrency: 1,
      claim: async () => (queue.length ? queue.shift()! : null),
      run: async (job) => {
        if (job === 2) throw new Error('boom');
        ok.push(job);
      },
      onRunError: (e) => runErrors.push(e),
    });

    pool.pump();
    while (queue.length > 0 || pool.active > 0) await tick();

    expect(ok).toEqual([1, 3]); // 2 threw but didn't wedge the pump
    expect(runErrors.length).toBe(1);
    expect(pool.active).toBe(0);
  });

  test('concurrency below 1 / non-finite is clamped to 1', () => {
    const mk = (c: number) =>
      createWorkerPool<number>({ concurrency: c, claim: async () => null, run: async () => {} });
    expect(mk(0).concurrency).toBe(1);
    expect(mk(-3).concurrency).toBe(1);
    expect(mk(Number.NaN).concurrency).toBe(1);
    expect(mk(2.9).concurrency).toBe(2); // floored
    expect(mk(8).concurrency).toBe(8);
  });
});
