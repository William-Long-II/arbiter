import { describe, expect, test } from 'bun:test';
import * as cookies from '../src/web/cookies.ts';

describe('signed cookies', () => {
  test('round-trip: sign then verify recovers value', async () => {
    const value = 'my-session-id-' + crypto.randomUUID();
    const signed = await cookies.sign(value);
    expect(signed).toContain('.');
    const recovered = await cookies.verify(signed);
    expect(recovered).toBe(value);
  });

  test('verify rejects tampered value', async () => {
    const signed = await cookies.sign('original');
    const dot = signed.lastIndexOf('.');
    const tampered = `tampered.${signed.slice(dot + 1)}`;
    expect(await cookies.verify(tampered)).toBeNull();
  });

  test('verify rejects tampered signature', async () => {
    const signed = await cookies.sign('original');
    const dot = signed.lastIndexOf('.');
    const tampered = `${signed.slice(0, dot)}.AAAAAAAA`;
    expect(await cookies.verify(tampered)).toBeNull();
  });

  test('verify rejects missing dot', async () => {
    expect(await cookies.verify('no-signature-here')).toBeNull();
  });

  test('verify handles values containing dots', async () => {
    const value = 'a.b.c.d';
    const signed = await cookies.sign(value);
    expect(await cookies.verify(signed)).toBe(value);
  });
});
