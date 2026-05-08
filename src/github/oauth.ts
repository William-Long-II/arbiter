import type { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from '../config.ts';
import { SESSION_COOKIE, STATE_COOKIE, sign, verify } from '../web/cookies.ts';
import { createSession, deleteSession, upsertUser } from '../db/users.ts';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const STATE_TTL_SECONDS = 60 * 10;             // 10 minutes
const SCOPES = 'repo read:org read:user';

const isProd = process.env.NODE_ENV === 'production';

export function mountGithubOAuth(app: Hono): void {
  app.get('/auth/github', async (c) => {
    if (!config.github.clientId || !config.github.clientSecret) {
      return c.text('GitHub OAuth not configured (set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET)', 500);
    }
    const state = crypto.randomUUID();
    setCookie(c, STATE_COOKIE, await sign(state), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isProd,
      path: '/',
      maxAge: STATE_TTL_SECONDS,
    });
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', config.github.clientId);
    url.searchParams.set('redirect_uri', `${config.publicUrl}/auth/github/callback`);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('state', state);
    return c.redirect(url.toString());
  });

  app.get('/auth/github/callback', async (c) => {
    const code = c.req.query('code');
    const incomingState = c.req.query('state');
    if (!code || !incomingState) return c.text('Missing code or state', 400);

    const signedState = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: '/' });
    if (!signedState) return c.text('Missing state cookie', 400);
    const expectedState = await verify(signedState);
    if (!expectedState || expectedState !== incomingState) {
      return c.text('Invalid OAuth state', 400);
    }

    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: config.github.clientId,
        client_secret: config.github.clientSecret,
        code,
        redirect_uri: `${config.publicUrl}/auth/github/callback`,
      }),
    });
    if (!tokenRes.ok) return c.text(`GitHub token exchange failed: ${tokenRes.status}`, 502);
    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!tokenJson.access_token) {
      return c.text(`GitHub returned no token: ${tokenJson.error_description ?? tokenJson.error ?? 'unknown'}`, 502);
    }

    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!userRes.ok) return c.text(`GitHub /user failed: ${userRes.status}`, 502);
    const ghUser = (await userRes.json()) as {
      id: number;
      login: string;
      avatar_url?: string;
    };

    const user = await upsertUser({
      githubId: ghUser.id,
      githubLogin: ghUser.login,
      githubToken: tokenJson.access_token,
      avatarUrl: ghUser.avatar_url ?? null,
    });
    const session = await createSession(user.id, SESSION_TTL_SECONDS);
    setCookie(c, SESSION_COOKIE, await sign(session.id), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isProd,
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
    return c.redirect('/');
  });

  app.post('/auth/logout', async (c) => {
    const signed = getCookie(c, SESSION_COOKIE);
    if (signed) {
      const sessionId = await verify(signed);
      if (sessionId) await deleteSession(sessionId);
    }
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/');
  });
}
