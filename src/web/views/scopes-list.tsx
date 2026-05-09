import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import type { Scope } from '../../db/scopes.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  scopes: Scope[];
};

export const ScopesListPage: FC<Props> = ({ user, scopes }) => {
  return (
    <Layout title="Scopes" user={user} active="scopes">
      <header class="page-header page-header-with-action">
        <div>
          <h1>Scopes</h1>
          <p class="page-subhead">
            Rules that control which pull requests reviewme captures and at what scrutiny.
          </p>
        </div>
        <a class="cta-primary" href="/scopes/new">New scope</a>
      </header>

      {scopes.length === 0 ? (
        <div class="empty-state">
          <p>No scope rules yet.</p>
          <p>
            Create one from <a class="text-link" href="/scopes/new">/scopes/new</a> or pick a
            repo from <a class="text-link" href="/repos">/repos</a> to get started.
          </p>
        </div>
      ) : (
        <ul class="row-list scope-list">
          {scopes.map((s) => (
            <ScopeRow scope={s} />
          ))}
        </ul>
      )}
    </Layout>
  );
};

const ScopeRow: FC<{ scope: Scope }> = ({ scope }) => {
  return (
    <li class={scope.enabled ? 'queue-row scope-row' : 'queue-row scope-row scope-row-disabled'}>
      <div class="scope-row-main">
        <span class="scope-kind">{scope.targetKind === 'org' ? 'org' : 'repo'}</span>
        <span class="repo-full mono">{scope.target}</span>
        <span class="scope-arrow">→</span>
        <span class="branch mono-sm">{scope.baseBranchPattern}</span>
      </div>
      <div class="scope-row-meta">
        <ScrutinyPill scrutiny={scope.scrutiny} />
        {scope.claudeMode !== 'default' ? (
          <span class="badge-pill badge-pill-muted">{scope.claudeMode}</span>
        ) : null}
        {!scope.enabled ? (
          <span class="badge-pill badge-pill-muted">disabled</span>
        ) : null}
        <a class="cta-tertiary" href={`/scopes/${scope.id}`}>Edit</a>
      </div>
    </li>
  );
};

const ScrutinyPill: FC<{ scrutiny: Scope['scrutiny'] }> = ({ scrutiny }) => {
  const cls =
    scrutiny === 'strict'
      ? 'badge-pill scrutiny-strict'
      : scrutiny === 'light'
        ? 'badge-pill scrutiny-light'
        : 'badge-pill';
  return <span class={cls}>{scrutiny}</span>;
};
