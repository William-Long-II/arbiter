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

  test('collapses an upstream HTML error page to one diagnostic line', () => {
    // The review-#2734 case: GitHub's diff endpoint timed out and Octokit
    // threw an HttpError whose message was the entire "Unicorn!" 503 page
    // (~300 KB of markup + base64 images) — which then landed verbatim in
    // pending_reviews.error and the logs.
    class HttpError extends Error {
      status: number;
      constructor(m: string, status: number) {
        super(m);
        this.name = 'HttpError';
        this.status = status;
      }
    }
    const page =
      '<!DOCTYPE html>\n<html>\n<head>\n<title>Unicorn! &middot; GitHub</title>\n' +
      '<style>#suggestions { color: #ccc; }</style>\n</head>\n<body>\n' +
      `<img src="data:image/png;base64,${'iVBORw0KGgo'.repeat(1000)}">\n` +
      '<p>Sorry about that. Please try refreshing.</p>\n</body>\n</html>';
    const out = describeError(new HttpError(page, 503));
    expect(out).toBe(
      'HttpError: upstream returned an HTML error page (HTTP 503, "Unicorn! · GitHub")',
    );
  });

  test('collapses an HTML page without status or title', () => {
    const out = describeError(new Error('<html><body>nope</body></html>'));
    expect(out).toBe('upstream returned an HTML error page');
  });

  test('does not touch messages that merely mention HTML', () => {
    expect(describeError(new Error('expected <html> tag in output'))).toBe(
      'expected <html> tag in output',
    );
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
