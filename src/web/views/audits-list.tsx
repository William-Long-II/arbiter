import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import type { AuditRun } from '../../db/audits.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  runs: AuditRun[];
};

/** Index of past retro-audit runs, newest first, plus the entry point to
 *  start a new one. */
export const AuditsListPage: FC<Props> = ({ user, runs }) => {
  return (
    <Layout title="Audits" user={user} active="audits">
      <header class="page-header page-header-with-action">
        <div>
          <h1>Audits</h1>
          <p class="page-subhead">
            Retro-audit already-merged PRs to surface issues that shipped
            without a review. Report-only — nothing is posted to GitHub.
          </p>
        </div>
        <a class="cta-primary" href="/audits/new">⏱ New audit</a>
      </header>

      {runs.length === 0 ? (
        <div class="card empty-card">
          <p class="empty-card-title">No audits yet.</p>
          <p class="empty-card-body">
            <a class="text-link" href="/audits/new">Run your first audit</a> to
            back-review a repo's recently merged PRs.
          </p>
        </div>
      ) : (
        <div class="card list-card">
          <div class="list-card-header audit-runs-header">
            <span>Repository</span>
            <span>Scope</span>
            <span>Started</span>
            <span>{/* link column */}</span>
          </div>
          <ul class="row-list">
            {runs.map((run) => (
              <li class="queue-row audit-run-row">
                <span class="mono-sm queue-row-repo">{run.repoFull}</span>
                <span class="page-subhead">
                  {run.enqueuedCount}/{run.requestedCount} PRs · {run.scrutiny}
                </span>
                <span class="queue-row-time">{formatRelative(run.createdAt)}</span>
                <a class="cta-tertiary queue-row-link" href={`/audits/${run.id}`}>
                  View report
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Layout>
  );
};

function formatRelative(d: Date | string): string {
  const then = new Date(d).getTime();
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
