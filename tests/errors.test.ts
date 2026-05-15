import { describe, expect, test } from 'bun:test';
import { describeError } from '../src/errors.ts';

describe('describeError', () => {
  test('returns a plain Error message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  test('prefixes the class name for typed errors', () => {
    class HttpError extends Error {
      constructor(m: string) {
        super(m);
        this.name = 'HttpError';
      }
    }
    expect(describeError(new HttpError('Unprocessable Entity'))).toBe(
      'HttpError: Unprocessable Entity',
    );
  });

  test('never returns empty for an Error with a blank message', () => {
    // This is the row-3333 case: an Error thrown with no message.
    const out = describeError(new Error(''));
    expect(out).not.toBe('');
    expect(out).toContain('no message');
  });

  test('uses the first stack frame when message is blank', () => {
    const e = new Error('');
    e.stack = 'Error\n    at somewhere (file.ts:1:2)';
    expect(describeError(e)).toBe('Error (no message) @ at somewhere (file.ts:1:2)');
  });

  test('handles thrown non-Error values without returning empty', () => {
    expect(describeError('')).toBe('Non-error thrown: empty string');
    expect(describeError('  ')).toBe('Non-error thrown: empty string');
    expect(describeError(null)).toBe('Non-error thrown: null');
    expect(describeError(undefined)).toBe('Non-error thrown: undefined');
    expect(describeError('plain string error')).toBe('plain string error');
    expect(describeError({ code: 'X' })).toBe('Non-error thrown: {"code":"X"}');
    expect(describeError(42)).toBe('Non-error thrown: 42');
  });

  test('falls back gracefully for a non-serialisable object', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = describeError(circular);
    expect(out).not.toBe('');
    // String({}) is "[object Object]" — better than blank.
    expect(out.length).toBeGreaterThan(0);
  });
});
