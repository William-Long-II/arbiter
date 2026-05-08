import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import type { Repo } from '../../github/repos.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  repos: Repo[];
  query: string;
};

export const ReposPage: FC<Props> = ({ user, repos, query }) => {
  return (
    <Layout title="Repos" user={user} active="repos">
      <header class="page-header">
        <h1>Repos</h1>
        <p class="page-subhead">Repositories you can access via your GitHub account.</p>
      </header>

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
