import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { mountGithubOAuth } from '../github/oauth.ts';
import { sql } from '../db.ts';
import { currentUser, requireUser } from './auth.ts';
import { filterRepos, listAccessibleRepos } from '../github/repos.ts';
import { ReposPage } from './views/repos.tsx';

const here = dirname(fileURLToPath(import.meta.url));
const staticRoot = join(here, 'static');

export function buildApp(): Hono {
  const app = new Hono();

  app.get('/healthz', async (c) => {
    try {
      await sql`SELECT 1`;
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 503);
    }
  });

  app.use('/static/*', serveStatic({ root: relativeTo(staticRoot, process.cwd()), rewriteRequestPath: (p) => p.replace(/^\/static/, '') }));

  app.get('/', async (c) => {
    const user = await currentUser(c);
    return c.html(landingPage(user?.githubLogin ?? null));
  });

  app.get('/me', async (c) => {
    const user = await currentUser(c);
    if (!user) return c.json({ user: null }, 401);
    return c.json({
      user: {
        id: user.id,
        login: user.githubLogin,
        avatarUrl: user.avatarUrl,
      },
    });
  });

  app.get('/api/repos', requireUser, async (c) => {
    const user = c.get('user');
    const result = await listAccessibleRepos(user.githubToken);
    return c.json(result);
  });

  app.get('/repos', requireUser, async (c) => {
    const user = c.get('user');
    const query = c.req.query('q') ?? '';
    const { repos: all, sources } = await listAccessibleRepos(user.githubToken);
    const repos = filterRepos(all, query);
    return c.html(<ReposPage user={user} repos={repos} sources={sources} query={query} />);
  });

  mountGithubOAuth(app);

  return app;
}

function relativeTo(target: string, from: string): string {
  // hono/bun serveStatic wants a path relative to the process cwd.
  const targetNormalized = target.replace(/\\/g, '/');
  const fromNormalized = from.replace(/\\/g, '/');
  if (targetNormalized.startsWith(fromNormalized + '/')) {
    return targetNormalized.slice(fromNormalized.length + 1);
  }
  return targetNormalized;
}

function landingPage(login: string | null): string {
  const right = login
    ? `<form method="POST" action="/auth/logout" style="display:inline">
         <button class="cta-secondary">Sign out (${escapeHtml(login)})</button>
       </form>`
    : `<a class="cta" href="/auth/github">Sign in with GitHub</a>`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>reviewme</title>
  <style>
    body { background:#010102; color:#f7f8f8; font-family: Inter, system-ui, sans-serif; margin:0; }
    main { max-width:560px; padding:96px 24px; margin:0 auto; }
    h1 { font-size:32px; font-weight:600; letter-spacing:-0.6px; margin:0 0 8px; }
    p { color:#8a8f98; font-size:14px; line-height:1.5; }
    a.cta, button.cta-secondary {
      display:inline-block; padding:8px 14px; border-radius:8px;
      font-size:13px; font-weight:500; text-decoration:none; margin-top:24px;
      border: none; cursor: pointer; font-family: inherit;
    }
    a.cta { background:#cc785c; color:#fff; }
    button.cta-secondary { background:#0f1011; color:#f7f8f8; border:1px solid #23252a; }
    code { font-family: "JetBrains Mono", ui-monospace, monospace; color:#d0d6e0; }
  </style>
</head>
<body>
  <main>
    <h1>reviewme</h1>
    <p>Greenfield rewrite. Web UI not implemented yet — this is a placeholder.</p>
    <p>Health: <code>GET /healthz</code></p>
    ${right}
  </main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
