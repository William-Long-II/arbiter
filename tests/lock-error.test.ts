import { describe, expect, test } from 'bun:test';
import { isLockedConversationError } from '../src/github/pulls.ts';

// Reconstructed from the real Octokit RequestError observed in production
// (pending_reviews rows 10 & 11): createReview → HTTP 422, and GitHub
// returns the detail as a quoted *string* in `errors`, not a {code} object.
function lockError(): Error & { status: number; response: { data: unknown } } {
  const err = new Error(
    'Unprocessable Entity: "lock prevents review" - ' +
      'https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request',
  ) as Error & { status: number; response: { data: unknown } };
  err.name = 'HttpError';
  err.status = 422;
  err.response = {
    data: {
      message: 'Unprocessable Entity',
      errors: ['lock prevents review'],
      documentation_url:
        'https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request',
    },
  };
  return err;
}

describe('isLockedConversationError', () => {
  test('detects the real production lock error', () => {
    expect(isLockedConversationError(lockError())).toBe(true);
  });

  test('detects it via the message alone (defensive)', () => {
    const e = Object.assign(new Error('... lock prevents review ...'), {
      status: 422,
    });
    expect(isLockedConversationError(e)).toBe(true);
  });

  test('detects it when the body is a raw string', () => {
    const e = Object.assign(new Error('422'), {
      status: 422,
      response: { data: 'lock prevents review' },
    });
    expect(isLockedConversationError(e)).toBe(true);
  });

  test('does NOT match an unrelated 422', () => {
    const e = Object.assign(new Error('Validation Failed'), {
      status: 422,
      response: {
        data: {
          message: 'Validation Failed',
          errors: [{ resource: 'PullRequestReview', code: 'custom' }],
        },
      },
    });
    expect(isLockedConversationError(e)).toBe(false);
  });

  test('does NOT match a non-422 error that mentions lock', () => {
    const e = Object.assign(new Error('lock prevents review'), { status: 500 });
    expect(isLockedConversationError(e)).toBe(false);
  });

  test('does NOT match generic / non-object throws', () => {
    expect(isLockedConversationError(null)).toBe(false);
    expect(isLockedConversationError(undefined)).toBe(false);
    expect(isLockedConversationError('lock prevents review')).toBe(false);
    expect(isLockedConversationError(new Error('socket hang up'))).toBe(false);
  });
});
