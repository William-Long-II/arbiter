import { describe, expect, test } from 'bun:test';
import { fmtCostUsd } from '../src/web/views/queue-list.tsx';

describe('fmtCostUsd', () => {
  test('sub-cent costs keep 4 decimals', () => {
    expect(fmtCostUsd(0.0034)).toBe('$0.0034');
    expect(fmtCostUsd(0.0009)).toBe('$0.0009');
  });

  test('sub-dollar costs keep 3 decimals', () => {
    expect(fmtCostUsd(0.021)).toBe('$0.021');
    expect(fmtCostUsd(0.156)).toBe('$0.156');
  });

  test('dollar-and-up costs keep 2 decimals', () => {
    expect(fmtCostUsd(1.5)).toBe('$1.50');
    expect(fmtCostUsd(12)).toBe('$12.00');
  });

  test('zero, negative, and non-finite collapse to $0.00', () => {
    expect(fmtCostUsd(0)).toBe('$0.00');
    expect(fmtCostUsd(-1)).toBe('$0.00');
    expect(fmtCostUsd(NaN)).toBe('$0.00');
    expect(fmtCostUsd(Infinity)).toBe('$0.00');
  });

  test('rounds at the chosen precision', () => {
    expect(fmtCostUsd(0.00005)).toBe('$0.0001'); // sub-cent → 4dp, rounds up
    expect(fmtCostUsd(0.9999)).toBe('$1.000'); // still <1 bucket → 3dp
  });
});
