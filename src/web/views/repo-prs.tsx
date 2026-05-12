import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import type { PRDetails } from '../../github/pulls.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  repoFull: string;
  prs: PRDetails[];
  /** Pre-selected scrutiny from the toolbar (or query param). */
  scrutiny: 'light' | 'standard' | 'strict';
  /** Pre-selected claude mode. 'default' falls back to server config. */
  claudeMode: 'default' | 'subscription' | 'api';
  autoApprove: boolean;
  /** Optional inline error from a failed enqueue attempt. */
  error?: string;
};

export const RepoPrsPage: FC<Props> = ({
  user,
  repoFull,
  prs,
  scrutiny,
  claudeMode,
  autoApprove,
  error,
}) => {
  return (
    <Layout title={`PRs · ${repoFull}`} user={user} active="repos">
      <header class="page-header page-header-with-action">
        <div>
          <h1>
            <span class="mono-sm queue-detail-prnum">{repoFull}</span>
          </h1>
          <p class="page-subhead">
            Open pull requests. Click <strong>Review</strong> on any row to enqueue an
            ad-hoc review (no scope required). The toolbar settings apply to whichever
            PR you click.
          </p>
        </div>
        <a class="cta-secondary" href="/repos">← All repos</a>
      </header>

      {error ? (
        <div class="form-errors">
          <strong>Couldn't enqueue:</strong> {error}
        </div>
      ) : null}

      <form class="page-toolbar repo-prs-toolbar" method="get" action={pageUrl(repoFull)}>
        <label class="toolbar-field">
          <span class="toolbar-field-label">Scrutiny</span>
          <select class="text-input" name="scrutiny">
            <option value="light" selected={scrutiny === 'light'}>light</option>
            <option value="standard" selected={scrutiny === 'standard'}>standard</option>
            <option value="strict" selected={scrutiny === 'strict'}>strict</option>
          </select>
        </label>
        <label class="toolbar-field">
          <span class="toolbar-field-label">Mode</span>
          <select class="text-input" name="claude_mode">
            <option value="default" selected={claudeMode === 'default'}>default</option>
            <option value="subscription" selected={claudeMode === 'subscription'}>subscription</option>
            <option value="api" selected={claudeMode === 'api'}>api</option>
          </select>
        </label>
        <label class="checkbox toolbar-checkbox">
          <input type="checkbox" name="auto_approve" value="1" checked={autoApprove} />
          <span>Auto-approve</span>
        </label>
        <button class="cta-secondary" type="submit">Apply defaults</button>
      </form>

      {prs.length === 0 ? (
        <div class="card empty-card">
          <p class="empty-card-title">No open PRs in this repo.</p>
          <p class="empty-card-body">
            Drafts are hidden. Push a PR or undraft an existing one to see it here.
          </p>
        </div>
      ) : (
        <div class="card list-card">
          <div class="list-card-header repo-prs-header">
            <span>PR</span>
            <span>Author</span>
            <span>Base ← Head</span>
            <span>{/* action col */}</span>
          </div>
          <ul class="row-list">
            {prs.map((pr) => (
              <PrRow
                pr={pr}
                repoFull={repoFull}
                scrutiny={scrutiny}
                claudeMode={claudeMode}
                autoApprove={autoApprove}
              />
            ))}
          </ul>
        </div>
      )}
    </Layout>
  );
};

const PrRow: FC<{
  pr: PRDetails;
  repoFull: string;
  scrutiny: string;
  claudeMode: string;
  autoApprove: boolean;
}> = ({ pr, repoFull, scrutiny, claudeMode, autoApprove }) => {
  return (
    <li class="repo-prs-row">
      <div class="repo-prs-pr">
        <span class="queue-row-prnum">#{pr.number}</span>
        <span class="queue-row-title">{pr.title}</span>
      </div>
      <span class="mono-sm ink-subtle">{pr.author}</span>
      <span class="repo-prs-branches">
        <span class="mono-sm">{pr.baseBranch}</span>
        <span class="queue-detail-arrow">←</span>
        <span class="mono-sm">{pr.headBranch}</span>
      </span>
      <form method="post" action={pageUrl(repoFull)} class="repo-prs-action">
        <input type="hidden" name="pr_number" value={String(pr.number)} />
        <input type="hidden" name="scrutiny" value={scrutiny} />
        <input type="hidden" name="claude_mode" value={claudeMode} />
        {autoApprove ? <input type="hidden" name="auto_approve" value="1" /> : null}
        <button class="cta-primary" type="submit">Review</button>
      </form>
    </li>
  );
};

function pageUrl(repoFull: string): string {
  const [owner, name] = repoFull.split('/');
  return `/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/prs`;
}

export { pageUrl as repoPrsUrl };
