import { describe, expect, test } from 'bun:test';
import { octokitFor, octokitCacheSize } from '../src/github/api.ts';

// The cache is a module singleton, so these tests share it. Assertions are
// written to hold regardless of insertion order from sibling tests (use
// unique key prefixes; only assert identity for keys this test controls).
describe('octokitFor client cache', () => {
  test('same token → same instance; different token → different', () => {
    const a1 = octokitFor('id-A');
    const a2 = octokitFor('id-A');
    const b = octokitFor('id-B');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  test('LRU-bounded; the untouched oldest is evicted', () => {
    const first = octokitFor('lru-0');
    for (let i = 1; i < 320; i++) octokitFor(`lru-${i}`); // well past the cap
    expect(octokitCacheSize()).toBeLessThanOrEqual(256);
    // lru-0 was oldest and never re-touched → evicted → fresh instance.
    expect(octokitFor('lru-0')).not.toBe(first);
  });

  test('a recently-touched key survives sub-cap churn', () => {
    const keep = octokitFor('survivor');
    octokitFor('survivor'); // touch → most-recently-used
    for (let i = 0; i < 200; i++) octokitFor(`churn-${i}`); // < 256 cap
    expect(octokitFor('survivor')).toBe(keep);
  });
});
