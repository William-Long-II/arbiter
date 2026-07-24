import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  /** Accessible repo full-names for the picker datalist. */
  repos: string[];
  /** Prefill the repo field (e.g. arriving from a repo page). */
  repoFull?: string;
  error?: string;
};

const COUNT_OPTIONS = [10, 25, 50, 100];

/**
 * Start a Time Machine retro-audit. Picks a repo + how many recently merged
 * PRs to back-review, then POSTs to /audits which fans out one report-only
 * review per merged PR. Nothing is posted to GitHub — the result is a
 * private report at /audits/:id.
 */
export const AuditNewPage: FC<Props> = ({ user, repos, repoFull, error }) => {
  return (
    <Layout title="New audit" user={user} active="audits">
      <header class="page-header page-header-with-action">
        <div>
          <h1>Retro-audit merged PRs</h1>
          <p class="page-subhead">
            Back-review the most recently merged PRs in a repo and get a
            ranked report of issues that shipped to your default branch — with
            nothing posted to GitHub.
          </p>
        </div>
        <a class="cta-secondary" href="/audits">← All audits</a>
      </header>

      {error ? (
        <div class="form-errors">
          <strong>Couldn't start the audit:</strong> {error}
        </div>
      ) : null}

      <form class="form" method="post" action="/audits">
        <fieldset class="form-row">
          <legend>Repository</legend>
          <input
            class="text-input form-input-wide"
            name="repo_full"
            list="audit-repo-list"
            placeholder="owner/name"
            value={repoFull ?? ''}
            required
            autofocus
          />
          <datalist id="audit-repo-list">
            {repos.map((r) => (
              <option value={r} />
            ))}
          </datalist>
          <p class="form-hint">
            Any repo your GitHub account can read. Start typing to filter your
            accessible repos.
          </p>
        </fieldset>

        <fieldset class="form-row">
          <legend>How many merged PRs</legend>
          <select class="text-input form-input-wide" name="count">
            {COUNT_OPTIONS.map((n) => (
              <option value={String(n)} selected={n === 50}>
                last {n} merged PRs
              </option>
            ))}
          </select>
          <p class="form-hint">
            Each is reviewed on your own Claude subscription. More PRs = a
            longer drain and more model spend.
          </p>
        </fieldset>

        <fieldset class="form-row">
          <legend>Scrutiny</legend>
          <select class="text-input form-input-wide" name="scrutiny">
            <option value="light">light</option>
            <option value="standard" selected>standard</option>
            <option value="strict">strict</option>
          </select>
        </fieldset>

        <fieldset class="form-row">
          <legend>Review context</legend>
          <select class="text-input form-input-wide" name="review_context">
            <option value="isolated" selected>isolated (diff only)</option>
            <option value="checkout">checkout (full repo working tree)</option>
          </select>
          <p class="form-hint">
            Checkout clones each merged PR's head so the model can verify
            cross-file references — more precise, but slower per PR.
          </p>
        </fieldset>

        <p class="form-hint">
          Report-only: these reviews never comment on, approve, or block the
          merged PRs. The result is a private report only you can see.
        </p>

        <div class="form-actions">
          <button class="cta-primary" type="submit">⏱ Run audit</button>
          <a class="cta-secondary" href="/audits">Cancel</a>
        </div>
      </form>
    </Layout>
  );
};
