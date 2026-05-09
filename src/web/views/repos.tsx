import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import { groupReposByOwner, type Repo, type RepoSource } from '../../github/repos.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  repos: Repo[];
  sources: RepoSource[];
  query: string;
  includeArchived: boolean;
  /** GitHub OAuth client ID — used to link to the user's app authorization page. */
  githubClientId: string;
};

export const ReposPage: FC<Props> = ({
  user,
  repos,
  sources,
  query,
  includeArchived,
  githubClientId,
}) => {
  const groups = groupReposByOwner(repos, user.githubLogin);
  const isFiltering = query.trim().length > 0;
  // Compute the widest repo-name string (in mono characters) across ALL
  // groups. Each group's <table> applies this as a min-width on its name
  // column so the columns align page-wide, not just within a group.
  const maxNameChars = Math.max(
    ...repos.map((r) => repoDisplayName(r).length),
    1,
  );

  return (
    <Layout title="Repos" user={user} active="repos">
      <header class="page-header">
        <h1>Repos</h1>
        <p class="page-subhead">
          Repositories you can access via your GitHub account. Showing {repos.length} repo
          {repos.length === 1 ? '' : 's'}{includeArchived ? ' (including archived)' : ''}.
        </p>
      </header>

      <SourcesPanel sources={sources} githubClientId={githubClientId} />

      <form
        class="page-toolbar repos-toolbar"
        method="get"
        action="/repos"
        onsubmit="this.classList.add('is-loading')"
      >
        <input
          class="text-input"
          name="q"
          placeholder="Filter by name…"
          value={query}
          autoComplete="off"
        />
        <label class="checkbox toolbar-checkbox">
          <input
            type="checkbox"
            name="include_archived"
            value="1"
            checked={includeArchived}
          />
          <span>Include archived</span>
        </label>
        <button class="cta-secondary toolbar-apply" type="submit">
          <span class="toolbar-apply-label">Apply</span>
          <span class="toolbar-apply-loading" aria-hidden="true">Loading…</span>
        </button>
        <a class="cta-tertiary toolbar-refresh" href="/repos?refresh=1" title="Refetch from GitHub (bypass 60s cache)">
          ↻ Refresh
        </a>
      </form>

      {repos.length === 0 ? (
        <div class="empty-state">
          {isFiltering
            ? <>No repositories match <code class="mono">{query}</code>{includeArchived ? '' : ' (archived hidden — toggle "Include archived" to show them)'}.</>
            : 'No repositories found for your account.'}
        </div>
      ) : (
        <div class="repo-groups">
          {groups.map((g) => (
            <RepoGroup
              owner={g.owner}
              repos={g.repos}
              defaultOpen={g.owner === user.githubLogin || isFiltering || groups.length === 1}
              maxNameChars={maxNameChars}
            />
          ))}
        </div>
      )}
    </Layout>
  );
};

function repoDisplayName(r: Repo): string {
  return r.fullName.split('/').slice(1).join('/');
}

const RepoGroup: FC<{
  owner: string;
  repos: Repo[];
  defaultOpen: boolean;
  maxNameChars: number;
}> = ({ owner, repos, defaultOpen, maxNameChars }) => {
  return (
    <details class="repo-group" open={defaultOpen}>
      <summary class="repo-group-header">
        <span class="repo-group-marker" aria-hidden="true">▸</span>
        <span class="mono-sm repo-group-owner">{owner}</span>
        <span class="repo-group-count">{repos.length}</span>
      </summary>
      {/*
        Real <table> here so the browser auto-aligns columns. With a flex
        list, rows without a `private` chip shrunk and the time column
        landed at a different x — the eye couldn't scan a column.
      */}
      <table class="repo-table">
        {/*
          Explicit column widths via <colgroup> + table-layout: fixed
          so columns align ACROSS tables, not just within. min-width on
          cells wasn't enough — auto-layout distributes leftover row
          width differently per table even with matching min-widths.
        */}
        <colgroup>
          <col style={`width:${maxNameChars + 1}ch`} />
          <col style="width:140px" />
          <col style="width:80px" />
          <col />
        </colgroup>
        <tbody>
          {repos.map((r) => (
            <RepoRow repo={r} />
          ))}
        </tbody>
      </table>
    </details>
  );
};

const RepoRow: FC<{ repo: Repo }> = ({ repo }) => {
  const name = repoDisplayName(repo);
  return (
    <tr class="repo-row">
      <td class="mono repo-row-name">{name}</td>
      <td class="repo-row-tags">
        {repo.private ? <span class="repo-row-tag">private</span> : null}
        {repo.archived ? <span class="repo-row-tag repo-row-tag-warn">archived</span> : null}
      </td>
      <td class="repo-row-time">
        {repo.pushedAt ? formatRelative(repo.pushedAt) : ''}
      </td>
      <td class="repo-row-filler" />
    </tr>
  );
};

const SourcesPanel: FC<{ sources: RepoSource[]; githubClientId: string }> = ({
  sources,
  githubClientId,
}) => {
  const emptyOrgs = sources.filter(
    (s): s is Extract<RepoSource, { kind: 'org' }> => s.kind === 'org' && s.status === 'empty',
  );
  const errorSources = sources.filter((s) => s.status === 'error');
  // GitHub's per-app authorization page where the user manages org access.
  const orgAccessUrl = githubClientId
    ? `https://github.com/settings/connections/applications/${githubClientId}`
    : null;
  return (
    <div class="sources-panel">
      <div class="sources-row">
        {sources.map((s) => (
          <SourcePill source={s} />
        ))}
        {orgAccessUrl ? (
          <a class="sources-manage" href={orgAccessUrl} target="_blank" rel="noopener noreferrer">
            Manage org access ↗
          </a>
        ) : null}
      </div>
      <p class="sources-hint">
        Missing an org you're a member of? It probably hasn't approved the reviewme OAuth app
        yet. {orgAccessUrl ? (
          <>
            Open <a class="text-link" href={orgAccessUrl} target="_blank" rel="noopener noreferrer">your app authorizations</a>{' '}
            on GitHub and request or grant access for the org.
          </>
        ) : (
          <>
            Open your GitHub OAuth authorizations and request or grant access for the org.
          </>
        )}
      </p>
      {emptyOrgs.length > 0 ? (
        <p class="sources-hint">
          {emptyOrgs.length === 1 ? 'Org' : 'Orgs'}{' '}
          {emptyOrgs.map((s, i) => (
            <>
              {i > 0 ? ', ' : ''}
              <code class="mono-sm">{s.org}</code>
            </>
          ))}{' '}
          returned no repos. If you expected repos there, the reviewme OAuth app
          likely needs approval at{' '}
          <code class="mono-sm">github.com/orgs/&lt;org&gt;/policies/applications</code>.
        </p>
      ) : null}
      {errorSources.length > 0 ? (
        <p class="sources-hint sources-hint-error">
          {errorSources.length} source{errorSources.length === 1 ? '' : 's'} failed —
          see <code class="mono-sm">/api/repos</code> for details.
        </p>
      ) : null}
    </div>
  );
};

const SourcePill: FC<{ source: RepoSource }> = ({ source }) => {
  const label = source.kind === 'user' ? 'your account' : source.org;
  const cls =
    source.status === 'error'
      ? 'badge-pill badge-pill-error'
      : source.status === 'empty'
        ? 'badge-pill badge-pill-muted'
        : 'badge-pill';
  // Org names are identifiers (mono); "your account" is prose (sans).
  const labelClass = source.kind === 'org' ? 'mono-sm' : '';
  return (
    <span class={cls}>
      <span class={labelClass}>{label}</span>
      <span class="badge-count">{source.count}</span>
    </span>
  );
};

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
