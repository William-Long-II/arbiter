import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import type { Scope, ScopeInput } from '../../db/scopes.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  /** Existing scope being edited, or null for create. */
  scope: Scope | null;
  /** Form values (for repopulating after a validation error). */
  values?: Partial<ScopeInput>;
  errors?: string[];
};

export const ScopeFormPage: FC<Props> = ({ user, scope, values, errors }) => {
  const editing = scope !== null;
  const v = {
    targetKind: values?.targetKind ?? scope?.targetKind ?? 'repo',
    target: values?.target ?? scope?.target ?? '',
    baseBranchPattern: values?.baseBranchPattern ?? scope?.baseBranchPattern ?? '*',
    scrutiny: values?.scrutiny ?? scope?.scrutiny ?? 'standard',
    excludeAuthors:
      values?.excludeAuthors ??
      scope?.excludeAuthors ??
      ['dependabot[bot]', 'renovate[bot]'],
    claudeMode: values?.claudeMode ?? scope?.claudeMode ?? 'default',
    enabled: values?.enabled ?? scope?.enabled ?? true,
  };

  const action = editing ? `/scopes/${scope!.id}` : '/scopes';
  const title = editing ? `Edit scope · ${scope!.target}` : 'New scope';

  return (
    <Layout title={editing ? 'Edit scope' : 'New scope'} user={user} active="scopes">
      <header class="page-header">
        <h1>{title}</h1>
        <p class="page-subhead">
          A scope tells reviewme which pull requests to capture and how strictly to review them.
        </p>
      </header>

      {errors && errors.length > 0 ? (
        <div class="form-errors">
          <strong>Couldn't save:</strong>
          <ul>
            {errors.map((e) => (
              <li>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <form class="form" method="post" action={action}>
        <fieldset class="form-row">
          <legend>Target</legend>
          <label class="radio">
            <input
              type="radio"
              name="target_kind"
              value="repo"
              checked={v.targetKind === 'repo'}
            />
            <span>Single repo</span>
          </label>
          <label class="radio">
            <input
              type="radio"
              name="target_kind"
              value="org"
              checked={v.targetKind === 'org'}
            />
            <span>Whole org</span>
          </label>
          <input
            class="text-input form-input-wide"
            name="target"
            placeholder="owner/name (or just owner for an org)"
            value={v.target}
            autoComplete="off"
            required
          />
        </fieldset>

        <fieldset class="form-row">
          <legend>Base branch pattern</legend>
          <input
            class="text-input form-input-wide"
            name="base_branch_pattern"
            placeholder="* (any), main, release/* (prefix glob)"
            value={v.baseBranchPattern}
            autoComplete="off"
          />
          <p class="form-hint">
            Use <code class="mono-sm">*</code> for any branch, an exact name like{' '}
            <code class="mono-sm">main</code>, or a prefix glob like{' '}
            <code class="mono-sm">release/*</code>.
          </p>
        </fieldset>

        <fieldset class="form-row">
          <legend>Scrutiny</legend>
          <ScrutinyRadio name="scrutiny" value="light" current={v.scrutiny} />
          <ScrutinyRadio name="scrutiny" value="standard" current={v.scrutiny} />
          <ScrutinyRadio name="scrutiny" value="strict" current={v.scrutiny} />
          <p class="form-hint">
            Strict is best for protected branches like <code class="mono-sm">main</code>.
          </p>
        </fieldset>

        <fieldset class="form-row">
          <legend>Excluded authors</legend>
          {/*
            Render the children expression with no surrounding whitespace —
            JSX whitespace inside <textarea> becomes part of the submitted
            value (leading newlines / indented spaces).
          */}
          <textarea
            class="text-input form-textarea"
            name="exclude_authors"
            rows={4}
            placeholder="One per line"
          >{v.excludeAuthors.join('\n')}</textarea>
          <p class="form-hint">
            PRs by these GitHub logins will be skipped. Your own login is always skipped.
          </p>
        </fieldset>

        <fieldset class="form-row">
          <legend>Claude mode</legend>
          <label class="radio">
            <input
              type="radio"
              name="claude_mode"
              value="default"
              checked={v.claudeMode === 'default'}
            />
            <span>Default (use the server-wide setting)</span>
          </label>
          <label class="radio">
            <input
              type="radio"
              name="claude_mode"
              value="subscription"
              checked={v.claudeMode === 'subscription'}
            />
            <span>
              Subscription (<code class="mono-sm">claude -p</code> with your Max/Pro session)
            </span>
          </label>
          <label class="radio">
            <input
              type="radio"
              name="claude_mode"
              value="api"
              checked={v.claudeMode === 'api'}
            />
            <span>API key (per-token billing via ANTHROPIC_API_KEY)</span>
          </label>
        </fieldset>

        <fieldset class="form-row">
          <label class="checkbox">
            <input type="checkbox" name="enabled" checked={v.enabled} />
            <span>Enabled</span>
          </label>
        </fieldset>

        <div class="form-actions">
          <button class="cta-primary" type="submit">
            {editing ? 'Save changes' : 'Create scope'}
          </button>
          <a class="cta-secondary" href="/scopes">Cancel</a>
          {editing ? (
            <button
              class="cta-tertiary cta-tertiary-danger"
              type="submit"
              formMethod="post"
              formAction={`/scopes/${scope!.id}/delete`}
            >
              Delete
            </button>
          ) : null}
        </div>
      </form>
    </Layout>
  );
};

const ScrutinyRadio: FC<{ name: string; value: 'light' | 'standard' | 'strict'; current: string }> = ({
  name,
  value,
  current,
}) => {
  return (
    <label class="radio">
      <input type="radio" name={name} value={value} checked={current === value} />
      <span class={`scrutiny-radio scrutiny-radio-${value}`}>{value}</span>
    </label>
  );
};
