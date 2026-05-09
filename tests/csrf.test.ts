import { describe, expect, test } from 'bun:test';
import { buildApp } from '../src/web/server.tsx';

const PUBLIC_URL = process.env.PUBLIC_URL!;
const ORIGIN = new URL(PUBLIC_URL).origin;

describe('CSRF guard (requireSameOrigin)', () => {
  test('GET requests are allowed without Origin', async () => {
    const app = buildApp();
    const res = await app.request('/healthz');
    // /healthz hits the DB; we only care that it didn't 403.
    expect(res.status).not.toBe(403);
  });

  test('POST without Origin or Referer is rejected', async () => {
    const app = buildApp();
    const res = await app.request('/scopes', { method: 'POST', body: '' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('missing');
  });

  test('POST with mismatched Origin is rejected', async () => {
    const app = buildApp();
    const res = await app.request('/scopes', {
      method: 'POST',
      headers: { origin: 'https://evil.example.com' },
      body: '',
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('origin mismatch');
  });

  test('POST with mismatched Referer (and no Origin) is rejected', async () => {
    const app = buildApp();
    const res = await app.request('/scopes', {
      method: 'POST',
      headers: { referer: 'https://evil.example.com/foo' },
      body: '',
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('referer mismatch');
  });

  test('POST with matching Origin proceeds past CSRF guard', async () => {
    const app = buildApp();
    const res = await app.request('/scopes', {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: '',
    });
    // No session cookie → requireUser kicks in next, redirecting to /auth/github.
    // Either way, NOT 403 from the CSRF guard.
    expect(res.status).not.toBe(403);
  });

  test('POST with matching Referer (and no Origin) proceeds past CSRF guard', async () => {
    const app = buildApp();
    const res = await app.request('/scopes', {
      method: 'POST',
      headers: { referer: `${ORIGIN}/scopes/new` },
      body: '',
    });
    expect(res.status).not.toBe(403);
  });
});
