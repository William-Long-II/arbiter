import { afterEach, describe, expect, test } from 'bun:test';
import {
  getInstallationToken,
  githubAppConfigured,
  normalizeAppPrivateKey,
  resetInstallationTokenCache,
  type InstallationMinter,
} from '../src/github/app.ts';

const PEM =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIBfake\nlines\n-----END RSA PRIVATE KEY-----';

describe('normalizeAppPrivateKey', () => {
  test('passes a real PEM through unchanged', () => {
    expect(normalizeAppPrivateKey(PEM)).toBe(PEM);
  });

  test('converts literal backslash-n (the .env footgun) to newlines', () => {
    const escaped = PEM.replace(/\n/g, '\\n');
    expect(escaped).not.toContain('\n');
    expect(normalizeAppPrivateKey(escaped)).toBe(PEM);
  });

  test('decodes a base64-wrapped PEM', () => {
    const b64 = Buffer.from(PEM, 'utf8').toString('base64');
    expect(normalizeAppPrivateKey(b64)).toBe(PEM);
  });

  test('empty / whitespace yields empty string', () => {
    expect(normalizeAppPrivateKey('')).toBe('');
    expect(normalizeAppPrivateKey('   \n  ')).toBe('');
  });

  test('non-PEM non-base64 garbage is returned as-is (minter surfaces it)', () => {
    expect(normalizeAppPrivateKey('not a key!!!')).toBe('not a key!!!');
  });
});

describe('githubAppConfigured', () => {
  test('false when App env is unset (the default / test env)', () => {
    expect(githubAppConfigured()).toBe(false);
  });
});

describe('getInstallationToken', () => {
  afterEach(() => resetInstallationTokenCache());

  const tokenAt = (ms: number): { token: string; expiresAt: Date } => ({
    token: `tok-${ms}`,
    expiresAt: new Date(ms),
  });

  test('mints once then serves from cache while well within expiry', async () => {
    let calls = 0;
    const mint: InstallationMinter = async () => {
      calls++;
      return tokenAt(60 * 60_000); // expires 1h after epoch
    };
    const now = () => 0;

    const a = await getInstallationToken(42, { now, mint });
    const b = await getInstallationToken(42, { now, mint });
    expect(a.token).toBe('tok-3600000');
    expect(b).toEqual(a);
    expect(calls).toBe(1);
  });

  test('re-mints once the cached token is within the refresh margin', async () => {
    let calls = 0;
    const mint: InstallationMinter = async () => {
      calls++;
      return tokenAt(10 * 60_000 + calls); // distinct token each mint
    };
    // First mint at t=0 (expires at 600000).
    const first = await getInstallationToken(7, { now: () => 0, mint });
    // t=596000 → only 4s of headroom, inside the 5-min margin → re-mint.
    const second = await getInstallationToken(7, { now: () => 596_000, mint });
    expect(calls).toBe(2);
    expect(second.token).not.toBe(first.token);
  });

  test('concurrent callers for one installation share a single mint', async () => {
    let calls = 0;
    const mint: InstallationMinter = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return tokenAt(60 * 60_000);
    };
    const now = () => 0;
    const [a, b, c] = await Promise.all([
      getInstallationToken(99, { now, mint }),
      getInstallationToken(99, { now, mint }),
      getInstallationToken(99, { now, mint }),
    ]);
    expect(calls).toBe(1); // stampede control
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  test('different installations mint independently', async () => {
    let calls = 0;
    const mint: InstallationMinter = async (id) => {
      calls++;
      return { token: `tok-${id}`, expiresAt: new Date(60 * 60_000) };
    };
    const now = () => 0;
    const a = await getInstallationToken(1, { now, mint });
    const b = await getInstallationToken(2, { now, mint });
    expect(calls).toBe(2);
    expect(a.token).toBe('tok-1');
    expect(b.token).toBe('tok-2');
  });

  test('a mint failure propagates and does not poison the next attempt', async () => {
    let calls = 0;
    const mint: InstallationMinter = async () => {
      calls++;
      if (calls === 1) throw new Error('GitHub 401');
      return tokenAt(60 * 60_000);
    };
    const now = () => 0;
    await expect(getInstallationToken(5, { now, mint })).rejects.toThrow('GitHub 401');
    // inflight cleared in finally → a retry actually re-mints and succeeds.
    const ok = await getInstallationToken(5, { now, mint });
    expect(ok.token).toBe('tok-3600000');
    expect(calls).toBe(2);
  });
});
