import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { serveStatic } from 'hono/bun';
import { streamSSE } from 'hono/streaming';
import { subscribe } from '../events.ts';
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
import { fetchPullRequest, listOpenPullsForRepo } from '../github/pulls.ts';
import { getPollerStatus } from '../github/poller.ts';
import {
  DiffTooLargeError,
  MAX_DIFF_BYTES,
  ReviewTimeoutError,
  runReview,
} from '../review/runner.ts';
import {
  enqueueReview,
  getReview,
  isReviewStatus,
  listReviews,
  listReviewsForPR,
  retryFailedReview,
  type ReviewStatus,
} from '../db/reviews.ts';
import { QueuePage } from './views/queue-list.tsx';
import { QueueDetailPage } from './views/queue-detail.tsx';
import { RepoPrsPage } from './views/repo-prs.tsx';

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
    // Signed-in users go straight to where they want to be. The signed-out
    // landing is the only path that renders the marketing copy.
    if (user) return c.redirect('/queue');
    return c.html(landingPage());
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

  // Used by the layout's "next poll in Xs" indicator. Cheap (no DB hit) and
  // refetched only when the client-side countdown reaches zero, so total
  // traffic is one call per poll interval per loaded tab.
  app.get('/api/poller/status', requireUser, (c) => {
    return c.json(getPollerStatus());
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

  app.get('/scopes/new', requireUser, async (c) => {
    const user = c.get('user');
    const { accessibleRepos, accessibleOrgs } = await loadTargetSuggestions(user);
    return c.html(
      <ScopeFormPage
        user={user}
        scope={null}
        accessibleRepos={accessibleRepos}
        accessibleOrgs={accessibleOrgs}
      />,
    );
  });

  app.post('/scopes', requireUser, async (c) => {
    const user = c.get('user');
    const form = await readFormStrings(c);
    const parsed = parseScopeForm(form);
    if (!parsed.ok) {
      const { accessibleRepos, accessibleOrgs } = await loadTargetSuggestions(user);
      return c.html(
        <ScopeFormPage
          user={user}
          scope={null}
          values={partialFromForm(form)}
          errors={parsed.errors}
          accessibleRepos={accessibleRepos}
          accessibleOrgs={accessibleOrgs}
        />,
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
    const { accessibleRepos, accessibleOrgs } = await loadTargetSuggestions(user);
    return c.html(
      <ScopeFormPage
        user={user}
        scope={scope}
        accessibleRepos={accessibleRepos}
        accessibleOrgs={accessibleOrgs}
      />,
    );
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
      const { accessibleRepos, accessibleOrgs } = await loadTargetSuggestions(user);
      return c.html(
        <ScopeFormPage
          user={user}
          scope={existing}
          values={partialFromForm(form)}
          errors={parsed.errors}
          accessibleRepos={accessibleRepos}
          accessibleOrgs={accessibleOrgs}
        />,
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

  app.get('/repos/:owner/:name/prs', requireUser, async (c) => {
    const user = c.get('user');
    const repoFull = `${c.req.param('owner')}/${c.req.param('name')}`;
    const scrutiny = isScrutiny(c.req.query('scrutiny'))
      ? (c.req.query('scrutiny') as 'light' | 'standard' | 'strict')
      : 'standard';
    const claudeMode = isClaudeMode(c.req.query('claude_mode'))
      ? (c.req.query('claude_mode') as 'default' | 'subscription' | 'api')
      : 'default';
    const autoApprove = c.req.query('auto_approve') === '1';
    const error = c.req.query('error') ?? undefined;
    let prs: Awaited<ReturnType<typeof listOpenPullsForRepo>> = [];
    try {
      prs = await listOpenPullsForRepo(user.githubToken, repoFull);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.html(
        <RepoPrsPage
          user={user}
          repoFull={repoFull}
          prs={[]}
          scrutiny={scrutiny}
          claudeMode={claudeMode}
          autoApprove={autoApprove}
          error={`Couldn't list PRs: ${message}`}
        />,
        502,
      );
    }
    return c.html(
      <RepoPrsPage
        user={user}
        repoFull={repoFull}
        prs={prs}
        scrutiny={scrutiny}
        claudeMode={claudeMode}
        autoApprove={autoApprove}
        error={error}
      />,
    );
  });

  // POST handler for the per-PR Review button. Wraps the same enqueue
  // path the debug endpoint uses, but redirects to /queue/:id on success
  // (or back to the listing with ?error=... on failure).
  app.post('/repos/:owner/:name/prs', requireUser, async (c) => {
    const user = c.get('user');
    const repoFull = `${c.req.param('owner')}/${c.req.param('name')}`;
    const form = await readFormStrings(c);
    const prNumber = parseInt(form.pr_number ?? '', 10);
    if (Number.isNaN(prNumber) || prNumber <= 0) {
      return c.text('pr_number must be a positive integer', 400);
    }
    const scrutiny = isScrutiny(form.scrutiny) ? form.scrutiny : 'standard';
    const claudeModeRaw = form.claude_mode ?? 'default';
    const claudeMode =
      claudeModeRaw === 'default' ? config.claude.defaultMode :
      claudeModeRaw === 'subscription' || claudeModeRaw === 'api' ? claudeModeRaw :
      config.claude.defaultMode;
    const autoApprove = form.auto_approve === '1' || form.auto_approve === 'on';

    const backTo = `/repos/${encodeURIComponent(c.req.param('owner'))}/${encodeURIComponent(c.req.param('name'))}/prs?scrutiny=${scrutiny}&claude_mode=${claudeModeRaw}${autoApprove ? '&auto_approve=1' : ''}`;
    try {
      const { pr } = await fetchPullRequest(user.githubToken, repoFull, prNumber);
      const row = await enqueueReview({
        userId: user.id,
        repoFull: pr.repoFull,
        prNumber: pr.number,
        prTitle: pr.title,
        prAuthor: pr.author,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        headSha: pr.headSha,
        scrutiny,
        claudeMode,
        autoApprove,
        // Ad-hoc enqueue: no scope row to honor a custom footer template.
        // Built-in default is the safe choice.
        footerTemplate: null,
      });
      if (!row) {
        // Idempotency hit — same head SHA already queued. Find the existing
        // row and route there instead of confusing the user with a no-op.
        return c.redirect(`${backTo}&error=${encodeURIComponent('A review for this PR + head SHA was already enqueued. Check /queue.')}`);
      }
      return c.redirect(`/queue/${row.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.redirect(`${backTo}&error=${encodeURIComponent(message)}`);
    }
  });

  app.get('/queue', requireUser, async (c) => {
    const user = c.get('user');
    const statusParam = c.req.query('status');
    const statusFilter: ReviewStatus[] = statusParam
      ? statusParam.split(',').map((s) => s.trim()).filter(isReviewStatus)
      : [];
    const reviews = await listReviews(user.id, {
      limit: 100,
      statusFilter: statusFilter.length > 0 ? statusFilter : undefined,
    });
    return c.html(
      <QueuePage user={user} reviews={reviews} statusFilter={statusFilter} />,
    );
  });

  app.get('/queue/:id', requireUser, async (c) => {
    const user = c.get('user');
    const id = parseInt(c.req.param('id'), 10);
    if (Number.isNaN(id)) return c.notFound();
    const review = await getReview(user.id, id);
    if (!review) return c.notFound();
    const siblings = await listReviewsForPR(
      user.id,
      review.repoFull,
      review.prNumber,
      review.id,
    );
    return c.html(<QueueDetailPage user={user} review={review} siblings={siblings} />);
  });

  // Reset a failed review back to queued. Same-origin POST (CSRF guard
  // applies). 404 if the row isn't yours or isn't in failed state — we
  // don't want to retry running/done rows by accident.
  app.post('/queue/:id/retry', requireUser, async (c) => {
    const user = c.get('user');
    const id = parseInt(c.req.param('id'), 10);
    if (Number.isNaN(id)) return c.notFound();
    const row = await retryFailedReview(user.id, id);
    if (!row) {
      return c.text('Review not found or not in a failed state', 404);
    }
    return c.redirect(`/queue/${id}`);
  });

  // SSE stream of review state changes for the current user. Powered by
  // Postgres LISTEN/NOTIFY: the worker NOTIFYs after every state change,
  // db.ts's listener publishes onto the in-process events bus, and this
  // handler relays events for the authenticated user only.
  //
  // No polling. Updates land within ~10ms of the worker committing.
  app.get('/api/events/queue', requireUser, (c) => {
    const user = c.get('user');
    return streamSSE(c, async (stream) => {
      // Buffer for events that arrive before the consumer writes catch up.
      // Hono's stream.writeSSE is async; if a flurry of events arrive, we
      // want to serialize them rather than interleave writes.
      const queue: string[] = [];
      let writing = false;
      const drain = async () => {
        if (writing) return;
        writing = true;
        try {
          while (queue.length > 0) {
            const payload = queue.shift()!;
            await stream.writeSSE({ event: 'review', data: payload });
          }
        } finally {
          writing = false;
        }
      };

      const unsubscribe = subscribe(user.id, (event) => {
        queue.push(JSON.stringify(event));
        void drain();
      });

      // Some proxies idle-time out long-lived connections. A 25s heartbeat
      // (SSE comment line) keeps them open. EventSource on the client
      // ignores comments — they're just keep-alive.
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ data: '', event: 'heartbeat' }).catch(() => {});
      }, 25_000);

      // Send one connect event so the client knows the channel is live.
      await stream.writeSSE({ event: 'open', data: '{}' });

      // Park until the client disconnects.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        });
      });
    });
  });

  // Enqueue a review against a real PR. The worker picks it up on its
  // next tick, runs it, and posts the result back to the PR.
  //
  //   curl -X POST http://localhost:8787/api/debug/enqueue-review \
  //     -H 'origin: http://localhost:8787' \
  //     -H 'cookie: rm_session=...' \
  //     -H 'content-type: application/json' \
  //     -d '{"repoFull":"owner/name","prNumber":123,"scrutiny":"standard"}'
  app.post('/api/debug/enqueue-review', requireUser, async (c) => {
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
    const autoApprove = b.autoApprove === true;

    try {
      const { pr } = await fetchPullRequest(user.githubToken, repoFull, prNumber);
      const row = await enqueueReview({
        userId: user.id,
        repoFull: pr.repoFull,
        prNumber: pr.number,
        prTitle: pr.title,
        prAuthor: pr.author,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        headSha: pr.headSha,
        scrutiny,
        claudeMode: requestedMode,
        autoApprove,
        // Debug endpoint: use the built-in default footer. Real scope-driven
        // enqueues honor scope.footerTemplate via the poller.
        footerTemplate: null,
      });
      if (!row) {
        return c.json(
          { ok: true, alreadyQueued: true, message: 'A review for this PR + head SHA was already enqueued.' },
          200,
        );
      }
      return c.json({ ok: true, reviewId: row.id, status: row.status, queueUrl: `/queue/${row.id}` }, 202);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
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
 * Build autocomplete suggestions for the scope target input. Uses the
 * existing per-user 60s repo cache, so visiting /scopes/new doesn't pay
 * a fresh GitHub API roundtrip on every render. Falls back to empty lists
 * if listing fails — the form still renders, just without suggestions.
 */
async function loadTargetSuggestions(
  user: { id: number; githubToken: string; githubLogin: string },
): Promise<{ accessibleRepos: string[]; accessibleOrgs: string[] }> {
  try {
    const { repos, sources } = await listAccessibleReposCached(
      user.id,
      user.githubToken,
    );
    const accessibleRepos = repos.map((r) => r.fullName).sort();
    const accessibleOrgs = sources
      .filter((s): s is Extract<typeof s, { kind: 'org' }> => s.kind === 'org')
      .map((s) => s.org)
      .sort();
    return { accessibleRepos, accessibleOrgs };
  } catch {
    return { accessibleRepos: [], accessibleOrgs: [] };
  }
}

/**
 * Project a raw form submission into a Partial<ScopeInput> for re-rendering
 * the form after a validation failure (so the user doesn't lose what they
 * typed). All enum-typed fields are validated here so we don't pass invalid
 * values through with a type assertion.
 */
function partialFromForm(form: Record<string, string>): Parameters<typeof ScopeFormPage>[0]['values'] {
  let footerTemplate: string | null;
  switch (form.footer_mode) {
    case 'none':
      footerTemplate = '';
      break;
    case 'custom':
      footerTemplate = (form.footer_template ?? '').replace(/\s+$/, '') || '';
      break;
    case 'standard':
    default:
      footerTemplate = null;
      break;
  }
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
    autoApprove: form.auto_approve === 'on' || form.auto_approve === 'true',
    footerTemplate,
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

/**
 * Signed-out landing. Standalone HTML (no Layout) because Layout assumes
 * an authenticated user for the top-nav. Inline CSS so the page works on
 * the very first request before any static asset has loaded.
 */
function landingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>reviewme</title>
  <style>
    :root {
      --canvas: #010102;
      --surface-1: #0f1011;
      --hairline: #23252a;
      --ink: #f7f8f8;
      --ink-muted: #d0d6e0;
      --ink-subtle: #8a8f98;
      --primary: #cc785c;
      --primary-hover: #d68b6f;
      --on-primary: #fff;
    }
    * { box-sizing: border-box; }
    body {
      background: var(--canvas); color: var(--ink); margin: 0;
      font-family: Inter, -apple-system, system-ui, sans-serif;
      font-size: 14px; line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .wrap {
      max-width: 720px; padding: 96px 24px 64px; margin: 0 auto;
      min-height: 100vh; display: flex; flex-direction: column;
    }
    header { display: flex; align-items: center; gap: 10px; margin-bottom: 64px; }
    .mark { color: var(--primary); font-size: 16px; }
    .wordmark { font-size: 18px; font-weight: 600; letter-spacing: -0.2px; }
    h1 {
      font-size: 40px; font-weight: 600; letter-spacing: -0.8px; line-height: 1.1;
      margin: 0 0 16px;
    }
    .tagline {
      color: var(--ink-muted); font-size: 17px; line-height: 1.5;
      max-width: 560px; margin: 0 0 32px;
    }
    .cta {
      display: inline-flex; align-items: center; gap: 8px;
      background: var(--primary); color: var(--on-primary);
      padding: 10px 18px; height: 40px;
      border-radius: 8px;
      font-size: 14px; font-weight: 500;
      text-decoration: none;
      transition: background 120ms ease;
    }
    .cta:hover { background: var(--primary-hover); }
    .bullets {
      display: grid; grid-template-columns: 1fr; gap: 16px;
      margin: 64px 0 0; padding: 0; list-style: none;
    }
    @media (min-width: 720px) { .bullets { grid-template-columns: repeat(3, 1fr); } }
    .bullet {
      background: var(--surface-1);
      border: 1px solid var(--hairline);
      border-radius: 12px; padding: 20px;
    }
    .bullet h3 {
      margin: 0 0 6px; font-size: 14px; font-weight: 500; color: var(--ink);
    }
    .bullet p {
      margin: 0; color: var(--ink-subtle); font-size: 13px; line-height: 1.5;
    }
    footer {
      margin-top: auto; padding-top: 48px;
      color: var(--ink-subtle); font-size: 12px;
    }
    code {
      font-family: "JetBrains Mono", ui-monospace, monospace;
      color: var(--ink-muted); font-size: 12px;
    }
    a { color: var(--primary); text-decoration: none; }
    a:hover { color: var(--primary-hover); }
  </style>
</head>
<body>
  <main class="wrap">
    <header>
      <span class="mark" aria-hidden="true">◆</span>
      <span class="wordmark">reviewme</span>
    </header>

    <h1>Automated PR reviews,<br/>on your terms.</h1>
    <p class="tagline">
      reviewme watches the pull requests in repos and orgs you choose, runs them
      through Claude, and posts a structured review back. Self-hosted, your
      GitHub access, your subscription.
    </p>

    <a class="cta" href="/auth/github">Sign in with GitHub →</a>

    <ul class="bullets">
      <li class="bullet">
        <h3>Scope rules</h3>
        <p>
          Pick the repos or orgs you want covered, plus branch patterns.
          Skip your own PRs and bot authors automatically.
        </p>
      </li>
      <li class="bullet">
        <h3>Three scrutiny tiers</h3>
        <p>
          Light, standard, or strict — pick per scope. Strict pairs well with
          protected branches like <code>main</code> or <code>release/*</code>.
        </p>
      </li>
      <li class="bullet">
        <h3>Optional auto-approve</h3>
        <p>
          When the reviewer's verdict has no blockers, post as an actual
          <code>APPROVE</code>. Opt-in per scope.
        </p>
      </li>
    </ul>

    <footer>
      Health: <code>GET /healthz</code> · Source: self-hosted reviewme
    </footer>
  </main>
</body>
</html>`;
}

