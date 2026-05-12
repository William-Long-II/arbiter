import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import type { Scope, ScopeInput } from '../../db/scopes.ts';
import { DEFAULT_FOOTER_TEMPLATE } from '../../review/footer.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  /** Existing scope being edited, or null for create. */
  scope: Scope | null;
  /** Form values (for repopulating after a validation error). */
  values?: Partial<ScopeInput>;
  errors?: string[];
  /** Autocomplete suggestions: every accessible repo as "owner/name". */
  accessibleRepos?: string[];
  /** Autocomplete suggestions: unique org owners the user has access to. */
  accessibleOrgs?: string[];
};

export const ScopeFormPage: FC<Props> = ({
  user,
  scope,
  values,
  errors,
  accessibleRepos = [],
  accessibleOrgs = [],
}) => {
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
    autoApprove: values?.autoApprove ?? scope?.autoApprove ?? false,
    footerTemplate: values?.footerTemplate ?? scope?.footerTemplate ?? null,
    personalityPrompt: values?.personalityPrompt ?? scope?.personalityPrompt ?? null,
    triggerMode: values?.triggerMode ?? scope?.triggerMode ?? 'open',
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
          {/*
            Native <datalist> autocomplete. Two lists — repos (owner/name)
            and orgs (just owner) — and a tiny inline script swaps which
            list the target input uses based on the radio selection. No
            client framework, no fetch, just rendered server-side from
            the cached repo list.
          */}
          <input
            id="scope-target"
            class="text-input form-input-wide"
            name="target"
            placeholder={v.targetKind === 'org' ? 'owner' : 'owner/name'}
            value={v.target}
            list={v.targetKind === 'org' ? 'scope-orgs' : 'scope-repos'}
            autoComplete="off"
            required
          />
          <datalist id="scope-repos">
            {accessibleRepos.map((r) => (
              <option value={r} />
            ))}
          </datalist>
          <datalist id="scope-orgs">
            {accessibleOrgs.map((o) => (
              <option value={o} />
            ))}
          </datalist>
          {accessibleRepos.length > 0 ? (
            <p class="form-hint">
              Start typing — {accessibleRepos.length} repo
              {accessibleRepos.length === 1 ? '' : 's'} and {accessibleOrgs.length} org
              {accessibleOrgs.length === 1 ? '' : 's'} available from your account.
            </p>
          ) : null}
          <script
            dangerouslySetInnerHTML={{
              __html: `
                (function() {
                  var target = document.getElementById('scope-target');
                  if (!target) return;
                  document.querySelectorAll('input[name="target_kind"]').forEach(function(r) {
                    r.addEventListener('change', function() {
                      target.setAttribute('list', r.value === 'org' ? 'scope-orgs' : 'scope-repos');
                      target.setAttribute('placeholder', r.value === 'org' ? 'owner' : 'owner/name');
                    });
                  });
                })();
              `,
            }}
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
          <legend>Trigger</legend>
          <label class="radio">
            <input
              type="radio"
              name="trigger_mode"
              value="open"
              checked={v.triggerMode === 'open'}
            />
            <span>Every open PR matching this scope</span>
          </label>
          <label class="radio">
            <input
              type="radio"
              name="trigger_mode"
              value="review_requested"
              checked={v.triggerMode === 'review_requested'}
            />
            <span>Only when a review is requested from me</span>
          </label>
          <p class="form-hint">
            Review-requested uses GitHub's <code class="mono-sm">review-requested:@me</code>{' '}
            search — accounts for team memberships and dramatically shrinks the set of PRs
            the bot picks up. Drafts and PRs you haven't been tagged on are skipped.
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
            <input type="checkbox" name="auto_approve" checked={v.autoApprove} />
            <span>Auto-approve when no blockers</span>
          </label>
          <p class="form-hint">
            Post as a GitHub <code class="mono-sm">APPROVE</code> when the reviewer's verdict
            is <code class="mono-sm">approve</code>. Otherwise (or when the PR is yours, which
            GitHub blocks anyway) posts as a regular <code class="mono-sm">COMMENT</code>.
          </p>
        </fieldset>

        <fieldset class="form-row">
          <legend>Reviewer personality (optional)</legend>
          {/*
            Free-text guidance appended to the scrutiny system prompt. The
            scrutiny tier still controls verdict thresholds and output
            shape; this just adds focus, tone, or domain context.
          */}
          <textarea
            class="text-input form-textarea"
            name="personality_prompt"
            rows={4}
            placeholder="e.g. 'This is a Rust project — prefer idiomatic Rust patterns and flag any unwrap() in non-test code.' or 'Be especially strict on auth-related code.' or 'Keep responses to 5 bullet points or fewer.'"
          >{v.personalityPrompt ?? ''}</textarea>
          <p class="form-hint">
            Appended to the scrutiny tier's system prompt. Doesn't replace it —
            verdict thresholds and output format still come from{' '}
            <code class="mono-sm">{v.scrutiny}</code>. Leave blank for default
            behavior.
          </p>
        </fieldset>

        <fieldset class="form-row">
          <legend>Review footer</legend>
          {/*
            Tri-state: standard (null) / none ('') / custom (text). The
            radio drives db/scopes.ts's parseScopeForm. The textarea only
            matters when "custom" is selected; we pre-fill it with the
            user's prior custom value or the default template so they have
            a starting point to edit. The inline script swaps the
            textarea's disabled state for visual affordance.
          */}
          <label class="radio">
            <input
              type="radio"
              name="footer_mode"
              value="standard"
              data-footer-mode="standard"
              checked={v.footerTemplate === null}
            />
            <span>Standard (default text, reviewme adds it)</span>
          </label>
          <label class="radio">
            <input
              type="radio"
              name="footer_mode"
              value="none"
              data-footer-mode="none"
              checked={v.footerTemplate === ''}
            />
            <span>No footer (post the review body as-is)</span>
          </label>
          <label class="radio">
            <input
              type="radio"
              name="footer_mode"
              value="custom"
              data-footer-mode="custom"
              checked={typeof v.footerTemplate === 'string' && v.footerTemplate !== ''}
            />
            <span>Custom template</span>
          </label>
          <textarea
            class="text-input form-textarea"
            name="footer_template"
            rows={3}
            id="footer-template"
            disabled={!(typeof v.footerTemplate === 'string' && v.footerTemplate !== '')}
          >{v.footerTemplate && v.footerTemplate !== '' ? v.footerTemplate : DEFAULT_FOOTER_TEMPLATE}</textarea>
          <p class="form-hint">
            Available placeholders: <code class="mono-sm">{'{{scrutiny}}'}</code>,{' '}
            <code class="mono-sm">{'{{mode}}'}</code>,{' '}
            <code class="mono-sm">{'{{verdict}}'}</code>,{' '}
            <code class="mono-sm">{'{{posted_as}}'}</code>.
          </p>
          <script
            dangerouslySetInnerHTML={{
              __html: `
                (function() {
                  var ta = document.getElementById('footer-template');
                  if (!ta) return;
                  document.querySelectorAll('input[name="footer_mode"]').forEach(function(r) {
                    r.addEventListener('change', function() {
                      ta.disabled = r.value !== 'custom';
                      if (r.value === 'custom') ta.focus();
                    });
                  });
                })();
              `,
            }}
          />
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
