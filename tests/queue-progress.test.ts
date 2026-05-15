import { describe, expect, test } from 'bun:test';
import { fmtElapsed } from '../src/web/views/queue-list.tsx';

// fmtElapsed must stay byte-identical to the inline client ticker in
// queue-list.tsx (server render vs. 1s interval must never disagree).
// These cases pin the exact format the ticker emits.
describe('fmtElapsed', () => {
  test('sub-minute is bare seconds', () => {
    expect(fmtElapsed(0)).toBe('0s');
    expect(fmtElapsed(6)).toBe('6s');
    expect(fmtElapsed(59)).toBe('59s');
  });

  test('minute boundary switches to m + s', () => {
    expect(fmtElapsed(60)).toBe('1m 0s');
    expect(fmtElapsed(134)).toBe('2m 14s'); // the mockup's "reviewing · 2m 14s"
    expect(fmtElapsed(3599)).toBe('59m 59s');
  });

  test('hour boundary switches to h + m (drops seconds)', () => {
    expect(fmtElapsed(3600)).toBe('1h 0m');
    expect(fmtElapsed(3661)).toBe('1h 1m');
    expect(fmtElapsed(7380)).toBe('2h 3m');
  });
});
