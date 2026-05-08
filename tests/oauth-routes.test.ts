import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { mountGithubOAuth } from '../src/github/oauth.ts';

function makeApp() {
  const app = new Hono();
  mountGithubOAuth(app);
  return app;
}

describe('GET /auth/github', () => {
  test('redirects to GitHub authorize URL with state and scopes', async () => {
    const app = makeApp();
    const res = await app.request('/auth/github');
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    const url = new URL(location);
    expect(url.host).toBe('github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8787/auth/github/callback');
    expect(url.searchParams.get('scope')).toBe('repo read:org read:user');
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('set-cookie')).toContain('rm_oauth_state=');
  });
});

describe('GET /auth/github/callback', () => {
  test('rejects missing code', async () => {
    const app = makeApp();
    const res = await app.request('/auth/github/callback?state=abc');
    expect(res.status).toBe(400);
  });

  test('rejects missing state cookie', async () => {
    const app = makeApp();
    const res = await app.request('/auth/github/callback?code=x&state=abc');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Missing state cookie');
  });

  test('rejects mismatched state', async () => {
    const app = makeApp();
    const cookies = await import('../src/web/cookies.ts');
    const signed = await cookies.sign('expected-state');
    const res = await app.request('/auth/github/callback?code=x&state=different-state', {
      headers: { cookie: `rm_oauth_state=${signed}` },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Invalid OAuth state');
  });

  test('rejects forged state cookie', async () => {
    const app = makeApp();
    const res = await app.request('/auth/github/callback?code=x&state=abc', {
      headers: { cookie: 'rm_oauth_state=abc.fake-signature' },
    });
    expect(res.status).toBe(400);
  });
});
