import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import type { Repo, RepoSource } from '../../github/repos.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  repos: Repo[];
  sources: RepoSource[];
  query: string;
};

export const ReposPage: FC<Props> = ({ user, repos, sources, query }) => {
  return (
    <Layout title="Repos" user={user} active="repos">
      <header class="page-header">
        <h1>Repos</h1>
        <p class="page-subhead">Repositories you can access via your GitHub account.</p>
      </header>

      <SourcesPanel sources={sources} />

      <form class="page-toolbar" method="get" action="/repos">
        <input
          class="text-input"
          name="q"
          placeholder="Filter by name…"
          value={query}
          autoComplete="off"
        />
      </form>

      {repos.length === 0 ? (
        <div class="empty-state">
          {query
            ? <>No repositories match <code class="mono">{query}</code>.</>
            : 'No repositories found for your account.'}
        </div>
      ) : (
        <ul class="row-list">
          {repos.map((r) => (
            <RepoRow repo={r} />
          ))}
        </ul>
      )}
    </Layout>
  );
};

const SourcesPanel: FC<{ sources: RepoSource[] }> = ({ sources }) => {
  const emptyOrgs = sources.filter(
    (s): s is Extract<RepoSource, { kind: 'org' }> => s.kind === 'org' && s.status === 'empty',
  );
  const errorSources = sources.filter((s) => s.status === 'error');
  return (
    <div class="sources-panel">
      <div class="sources-row">
        {sources.map((s) => (
          <SourcePill source={s} />
        ))}
      </div>
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
          <code class="mono-sm">github.com/orgs/{'{org}'}/policies/applications</code>.
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
  return (
    <span class={cls}>
      <span class="mono-sm">{label}</span>
      <span class="badge-count">{source.count}</span>
    </span>
  );
};

const RepoRow: FC<{ repo: Repo }> = ({ repo }) => {
  return (
    <li class="queue-row">
      <span class="repo-full mono">{repo.fullName}</span>
      <span class="repo-meta">
        <span class="branch mono-sm">{repo.defaultBranch}</span>
        {repo.private ? <span class="badge-pill">private</span> : null}
        {repo.fork ? <span class="badge-pill">fork</span> : null}
        {repo.archived ? <span class="badge-pill">archived</span> : null}
        {repo.pushedAt ? (
          <span class="ink-subtle">{formatRelative(repo.pushedAt)}</span>
        ) : null}
      </span>
    </li>
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
