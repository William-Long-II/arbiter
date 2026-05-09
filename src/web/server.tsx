import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { serveStatic } from 'hono/bun';
import { mountGithubOAuth } from '../github/oauth.ts';
import { sql } from '../db.ts';
import { currentUser, requireUser } from './auth.ts';
import {
  excludeArchived,
  filterRepos,
  listAccessibleReposCached,
} from '../github/repos.ts';
import { ReposPage } from './views/repos.tsx';
import { config } from '../config.ts';
import { ScopesListPage } from './views/scopes-list.tsx';
import { ScopeFormPage } from './views/scope-form.tsx';
import {
  createScope,
  deleteScope,
  getScope,
  isClaudeMode,
  isScrutiny,
  isTargetKind,
  listScopes,
  parseScopeForm,
  updateScope,
} from '../db/scopes.ts';
import { fetchPullRequest } from '../github/pulls.ts';
import {
  DiffTooLargeError,
  MAX_DIFF_BYTES,
  ReviewTimeoutError,
  runReview,
} from '../review/runner.ts';

const here = dirname(fileURLToPath(import.meta.url));
const staticRoot = join(here, 'static');

export function buildApp(): Hono {
  const app = new Hono();

  // CSRF guard: any state-changing request must come from our own origin.
  // SameSite=Lax cookies stop most cross-origin POSTs, but Lax permits
  // top-level form-driven POSTs from other sites. Origin/Referer matching
  // closes that gap. GETs are skipped (idempotent by convention).
  app.use('*', requireSameOrigin);

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
    // Returns 200 + {user: null} when signed out — /me is a "describe my
    // session" endpoint, not an auth-required one. 401 with a JSON body
    // that looks like a successful response is the worst of both worlds.
    const user = await currentUser(c);
    if (!user) return c.json({ user: null });
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
    const refresh = c.req.query('refresh') === '1';
    const result = await listAccessibleReposCached(user.id, user.githubToken, { refresh });
    return c.json(result);
  });

  app.get('/repos', requireUser, async (c) => {
    const user = c.get('user');
    const query = c.req.query('q') ?? '';
    const includeArchived = c.req.query('include_archived') === '1';
    const refresh = c.req.query('refresh') === '1';
    const { repos: all, sources } = await listAccessibleReposCached(
      user.id,
      user.githubToken,
      { refresh },
    );
    const filtered = filterRepos(includeArchived ? all : excludeArchived(all), query);
    return c.html(
      <ReposPage
        user={user}
        repos={filtered}
        sources={sources}
        query={query}
        includeArchived={includeArchived}
        githubClientId={config.github.clientId}
      />,
    );
  });

  app.get('/scopes', requireUser, async (c) => {
    const user = c.get('user');
    const scopes = await listScopes(user.id);
    return c.html(<ScopesListPage user={user} scopes={scopes} />);
  });

  app.get('/scopes/new', requireUser, (c) => {
    const user = c.get('user');
    return c.html(<ScopeFormPage user={user} scope={null} />);
  });

  app.post('/scopes', requireUser, async (c) => {
    const user = c.get('user');
    const form = await readFormStrings(c);
    const parsed = parseScopeForm(form);
    if (!parsed.ok) {
      return c.html(
        <ScopeFormPage user={user} scope={null} values={partialFromForm(form)} errors={parsed.errors} />,
        400,
      );
    }
    await createScope(user.id, parsed.input);
    return c.redirect('/scopes');
  });

  app.get('/scopes/:id', requireUser, async (c) => {
    const user = c.get('user');
    const id = parseInt(c.req.param('id'), 10);
    if (Number.isNaN(id)) return c.notFound();
    const scope = await getScope(user.id, id);
    if (!scope) return c.notFound();
    return c.html(<ScopeFormPage user={user} scope={scope} />);
  });

  app.post('/scopes/:id', requireUser, async (c) => {
    const user = c.get('user');
    const id = parseInt(c.req.param('id'), 10);
    if (Number.isNaN(id)) return c.notFound();
    const existing = await getScope(user.id, id);
    if (!existing) return c.notFound();

    const form = await readFormStrings(c);
    const parsed = parseScopeForm(form);
    if (!parsed.ok) {
      return c.html(
        <ScopeFormPage user={user} scope={existing} values={partialFromForm(form)} errors={parsed.errors} />,
        400,
      );
    }
    await updateScope(user.id, id, parsed.input);
    return c.redirect('/scopes');
  });

  app.post('/scopes/:id/delete', requireUser, async (c) => {
    const user = c.get('user');
    const id = parseInt(c.req.param('id'), 10);
    if (Number.isNaN(id)) return c.notFound();
    await deleteScope(user.id, id);
    return c.redirect('/scopes');
  });

  // Debug endpoint: run a review on a real PR using the user's GitHub token.
  // Returns the review body as JSON. Does NOT post to the PR — this is a
  // dry-run for verifying the runner pipeline before the worker is wired up.
  //
  //   curl -X POST -H 'origin: http://localhost:8787' \
  //     -H 'cookie: rm_session=...' \
  //     -H 'content-type: application/json' \
  //     -d '{"repoFull":"owner/name","prNumber":123,"scrutiny":"standard"}' \
  //     http://localhost:8787/api/debug/run-review
  app.post('/api/debug/run-review', requireUser, async (c) => {
    const user = c.get('user');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Body must be JSON' }, 400);
    }
    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'Body must be a JSON object' }, 400);
    }
    const b = body as Record<string, unknown>;
    const repoFull = typeof b.repoFull === 'string' ? b.repoFull : null;
    const prNumber = typeof b.prNumber === 'number' ? b.prNumber : null;
    if (!repoFull || !prNumber) {
      return c.json({ error: 'repoFull (string) and prNumber (number) required' }, 400);
    }
    const scrutiny = isScrutiny(b.scrutiny) ? b.scrutiny : 'standard';
    const requestedMode =
      b.mode === 'subscription' || b.mode === 'api' ? b.mode : config.claude.defaultMode;

    try {
      const { pr, diff } = await fetchPullRequest(user.githubToken, repoFull, prNumber);
      const result = await runReview(
        {
          scrutiny,
          diff,
          prTitle: pr.title,
          prAuthor: pr.author,
          repoFull: pr.repoFull,
        },
        requestedMode,
      );
      return c.json({
        pr,
        scrutiny,
        mode: requestedMode,
        diffBytes: diff.length,
        review: { body: result.body, costUsd: result.costUsd ?? null },
      });
    } catch (err) {
      if (err instanceof DiffTooLargeError) {
        return c.json(
          { error: err.message, diffBytes: err.bytes, limit: MAX_DIFF_BYTES },
          413,
        );
      }
      if (err instanceof ReviewTimeoutError) {
        return c.json({ error: err.message }, 504);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  mountGithubOAuth(app);

  return app;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const requireSameOrigin: MiddlewareHandler = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method.toUpperCase())) return next();
  const expected = safeOrigin(config.publicUrl);
  const origin = c.req.header('origin');
  const referer = c.req.header('referer');
  if (origin) {
    if (origin === expected) return next();
    return c.text('Cross-origin request rejected (origin mismatch)', 403);
  }
  if (referer) {
    const refOrigin = safeOrigin(referer);
    if (refOrigin && refOrigin === expected) return next();
    return c.text('Cross-origin request rejected (referer mismatch)', 403);
  }
  return c.text('Cross-origin request rejected (missing Origin/Referer)', 403);
};

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Read form data, dropping any non-string entries (e.g. uploaded Files).
 * Form parsers downstream call `.trim()` etc. and would crash on non-strings.
 */
async function readFormStrings(c: Context): Promise<Record<string, string>> {
  const data = await c.req.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of data.entries()) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Project a raw form submission into a Partial<ScopeInput> for re-rendering
 * the form after a validation failure (so the user doesn't lose what they
 * typed). All enum-typed fields are validated here so we don't pass invalid
 * values through with a type assertion.
 */
function partialFromForm(form: Record<string, string>): Parameters<typeof ScopeFormPage>[0]['values'] {
  return {
    targetKind: isTargetKind(form.target_kind) ? form.target_kind : 'repo',
    target: form.target ?? '',
    baseBranchPattern: form.base_branch_pattern ?? '*',
    scrutiny: isScrutiny(form.scrutiny) ? form.scrutiny : 'standard',
    excludeAuthors: (form.exclude_authors ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
    claudeMode: isClaudeMode(form.claude_mode) ? form.claude_mode : 'default',
    enabled: form.enabled === 'on' || form.enabled === 'true',
  };
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
