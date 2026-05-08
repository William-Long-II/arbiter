// GitHub OAuth flow — stub. Real implementation lands in a follow-up.
// Routes:
//   GET  /auth/github          → redirect to github.com/login/oauth/authorize
//   GET  /auth/github/callback → exchange code for token, upsert user, set cookie

import type { Hono } from 'hono';
import { config } from '../config.ts';

export function mountGithubOAuth(app: Hono): void {
  app.get('/auth/github', (c) => {
    if (!config.github.clientId) {
      return c.text('GITHUB_CLIENT_ID not configured', 500);
    }
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', config.github.clientId);
    url.searchParams.set('redirect_uri', `${config.publicUrl}/auth/github/callback`);
    url.searchParams.set('scope', 'repo read:org read:user');
    url.searchParams.set('state', crypto.randomUUID());
    return c.redirect(url.toString());
  });

  app.get('/auth/github/callback', (c) => {
    // TODO: exchange code → token, upsert user, create session, set cookie
    return c.text('OAuth callback not implemented yet', 501);
  });
}
