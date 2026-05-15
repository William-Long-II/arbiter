import { describe, expect, test } from 'bun:test';
import { isTransientError, MAX_ATTEMPTS, retryDelaySeconds } from '../src/retry.ts';

describe('retryDelaySeconds', () => {
  test('exponential, 1-based, capped at 600s', () => {
    expect(retryDelaySeconds(1)).toBe(30);
    expect(retryDelaySeconds(2)).toBe(60);
    expect(retryDelaySeconds(3)).toBe(120);
    expect(retryDelaySeconds(4)).toBe(240);
    expect(retryDelaySeconds(5)).toBe(480);
    expect(retryDelaySeconds(6)).toBe(600); // 960 → capped
    expect(retryDelaySeconds(50)).toBe(600);
  });

  test('attempt ≤ 1 (or junk) treated as the first retry', () => {
    expect(retryDelaySeconds(0)).toBe(30);
    expect(retryDelaySeconds(-3)).toBe(30);
    expect(retryDelaySeconds(1.9)).toBe(30);
  });

  test('MAX_ATTEMPTS allows three automatic retries', () => {
    expect(MAX_ATTEMPTS).toBe(4);
  });
});

describe('isTransientError', () => {
  test('GitHub 5xx / 408 / 429 are transient', () => {
    expect(isTransientError({ status: 500 })).toBe(true);
    expect(isTransientError({ status: 502 })).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ status: 408 })).toBe(true);
    expect(isTransientError({ status: 429 })).toBe(true);
  });

  test('403 is transient only when it is a rate limit', () => {
    expect(isTransientError({ status: 403, message: 'Forbidden' })).toBe(false);
    expect(
      isTransientError({ status: 403, message: 'You have exceeded a secondary rate limit' }),
    ).toBe(true);
    expect(
      isTransientError({ status: 403, message: 'API rate limit exceeded for user' }),
    ).toBe(true);
  });

  test('deterministic 4xx are not transient', () => {
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 404 })).toBe(false);
    expect(isTransientError({ status: 422 })).toBe(false);
  });

  test('socket-level network errors are transient', () => {
    expect(isTransientError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientError({ name: 'FetchError', message: 'x' })).toBe(true);
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
  });

  test('ordinary errors and non-objects are not transient', () => {
    expect(isTransientError(new Error('boom'))).toBe(false);
    expect(isTransientError('nope')).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});
