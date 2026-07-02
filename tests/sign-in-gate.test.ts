import { describe, expect, test } from 'bun:test';
import { isSignInAllowed, parseAllowedLogins } from '../src/settings.ts';

describe('parseAllowedLogins', () => {
  test('splits on commas and whitespace, lowercases, strips @', () => {
    const s = parseAllowedLogins('William-Long-II, @brannon\n  Someone-Else');
    expect(s).toEqual(new Set(['william-long-ii', 'brannon', 'someone-else']));
  });

  test('empty and junk-only input give an empty set', () => {
    expect(parseAllowedLogins('')).toEqual(new Set());
    expect(parseAllowedLogins(' ,,  \n ')).toEqual(new Set());
  });
});

describe('isSignInAllowed', () => {
  const allowlist = parseAllowedLogins('brannon');

  test('returning users always get in, even off-allowlist', () => {
    expect(
      isSignInAllowed({ login: 'will', isExistingUser: true, userCount: 3, allowlist }),
    ).toBe(true);
  });

  test('allowlisted logins get in (case-insensitive)', () => {
    expect(
      isSignInAllowed({ login: 'Brannon', isExistingUser: false, userCount: 3, allowlist }),
    ).toBe(true);
  });

  test('first sign-in claims a fresh instance', () => {
    expect(
      isSignInAllowed({ login: 'anyone', isExistingUser: false, userCount: 0, allowlist: new Set() }),
    ).toBe(true);
  });

  test('everyone else is denied once the instance is claimed', () => {
    expect(
      isSignInAllowed({ login: 'rando', isExistingUser: false, userCount: 1, allowlist }),
    ).toBe(false);
    expect(
      isSignInAllowed({ login: 'rando', isExistingUser: false, userCount: 1, allowlist: new Set() }),
    ).toBe(false);
  });
});
