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
        <div class="card empty-card">
          <p class="empty-card-title">No scope rules yet.</p>
          <p class="empty-card-body">
            Reviewme will only capture PRs that match a scope. Create one to start
            reviewing.
          </p>
          <a class="cta-primary" href="/scopes/new">Create your first scope</a>
        </div>
      ) : (
        <div class="card list-card">
          <div class="list-card-header">
            <span>Target</span>
            <span>Base branch</span>
            <span>Scrutiny</span>
            <span>{/* edit column */}</span>
          </div>
          <ul class="row-list scope-list">
            {scopes.map((s) => (
              <ScopeRow scope={s} />
            ))}
          </ul>
        </div>
      )}
    </Layout>
  );
};

const ScopeRow: FC<{ scope: Scope }> = ({ scope }) => {
  return (
    <li class={scope.enabled ? 'scope-row' : 'scope-row scope-row-disabled'}>
      <div class="scope-row-target">
        <span class="scope-kind">{scope.targetKind === 'org' ? 'org' : 'repo'}</span>
        <span class="mono scope-row-target-name">{scope.target}</span>
        {scope.claudeMode !== 'default' ? (
          <span class="badge-pill badge-pill-muted">{scope.claudeMode}</span>
        ) : null}
        {!scope.enabled ? (
          <span class="badge-pill badge-pill-muted">disabled</span>
        ) : null}
      </div>
      <span class="branch mono-sm scope-row-branch">{scope.baseBranchPattern}</span>
      <ScrutinyPill scrutiny={scope.scrutiny} />
      <a class="cta-tertiary scope-row-edit" href={`/scopes/${scope.id}`}>Edit</a>
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
