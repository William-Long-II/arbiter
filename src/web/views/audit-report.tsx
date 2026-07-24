import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import type { PendingReview } from '../../db/reviews.ts';
import type { AuditRun } from '../../db/audits.ts';
import type { AuditSummary } from '../../review/audit-rank.ts';
import type { FindingCounts, Severity } from '../../review/format.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  run: AuditRun;
  /** Done reviews, already ranked most-severe-first. */
  ranked: PendingReview[];
  summary: AuditSummary;
};

/**
 * Time Machine audit report. Leads with the headline damage ("N blocking, M
 * major shipped"), then a blocking-first list of every reviewed merged PR
 * linking to the PR on GitHub and to the full generated review at
 * /queue/:id. Auto-refreshes while the batch is still draining.
 */
export const AuditReportPage: FC<Props> = ({ user, run, ranked, summary }) => {
  const draining = summary.inProgress > 0;
  return (
    <Layout title={`Audit · ${run.repoFull}`} user={user} active="audits">
      <header class="page-header page-header-with-action">
        <div>
          <h1>
            Audit <span class="mono-sm">{run.repoFull}</span>
          </h1>
          <p class="page-subhead">
            Retro-review of the last {run.requestedCount} merged PRs ·{' '}
            {run.scrutiny} · {run.reviewContext} · nothing posted to GitHub.
          </p>
        </div>
        <a class="cta-secondary" href="/audits">← All audits</a>
      </header>

      <div class="card audit-summary-card">
        <p class="audit-headline">
          <strong>{summary.findings.blocking}</strong> blocking ·{' '}
          <strong>{summary.findings.major}</strong> major across{' '}
          <strong>{summary.done}</strong> reviewed PR
          {summary.done === 1 ? '' : 's'}
          {run.enqueuedCount > summary.done ? (
            <span class="page-subhead">
              {' '}
              ({summary.done} of {run.enqueuedCount} done
              {summary.inProgress > 0 ? `, ${summary.inProgress} in progress` : ''}
              {summary.failed > 0 ? `, ${summary.failed} failed/skipped` : ''})
            </span>
          ) : null}
        </p>
        {draining ? (
          <p class="page-subhead" data-audit-draining>
            Still reviewing… this page refreshes as results land.
          </p>
        ) : null}
      </div>

      {ranked.length === 0 ? (
        <div class="card empty-card">
          <p class="empty-card-title">
            {draining ? 'No results yet — reviews are still running.' : 'Nothing reviewed.'}
          </p>
          <p class="empty-card-body">
            {draining
              ? 'The first reviewed PRs will appear here shortly.'
              : run.enqueuedCount === 0
                ? 'No merged PRs were found to audit in this repo.'
                : 'All reviews failed or were skipped — check the queue for details.'}
          </p>
        </div>
      ) : (
        <div class="card list-card">
          <div class="list-card-header audit-list-header">
            <span>PR</span>
            <span>Verdict</span>
            <span>Findings</span>
            <span>{/* link column */}</span>
          </div>
          <ul class="row-list">
            {ranked.map((r) => (
              <AuditRow review={r} />
            ))}
          </ul>
        </div>
      )}

      {draining ? (
        <script
          dangerouslySetInnerHTML={{
            // Simple refresh while the batch drains; stops once nothing is in
            // progress (the [data-audit-draining] note is only rendered then).
            __html: `setTimeout(function(){ location.reload(); }, 4000);`,
          }}
        />
      ) : null}
    </Layout>
  );
};

const AuditRow: FC<{ review: PendingReview }> = ({ review }) => {
  const prUrl = `https://github.com/${review.repoFull}/pull/${review.prNumber}`;
  return (
    <li class="queue-row audit-row">
      <div class="queue-row-pr">
        <a class="mono-sm queue-row-repo text-link" href={prUrl} target="_blank" rel="noreferrer">
          {review.repoFull}#{review.prNumber}
        </a>
        <span class="queue-row-title">{review.prTitle}</span>
        <span class="page-subhead audit-row-author">@{review.prAuthor}</span>
      </div>
      {review.verdict ? (
        <span class={`badge-pill verdict-${review.verdict}`}>{review.verdict}</span>
      ) : (
        <span class="badge-pill badge-pill-muted">—</span>
      )}
      <FindingsBadges findings={review.findings} />
      <a class="cta-tertiary queue-row-link" href={`/queue/${review.id}`}>
        View review
      </a>
    </li>
  );
};

const SEVERITIES: readonly Severity[] = ['blocking', 'major', 'minor', 'nit'];

const FindingsBadges: FC<{ findings: FindingCounts | null }> = ({ findings }) => {
  if (!findings) return <span class="page-subhead">—</span>;
  const shown = SEVERITIES.filter((s) => findings[s] > 0);
  if (shown.length === 0) return <span class="badge-pill badge-pill-muted">clean</span>;
  return (
    <span class="audit-findings">
      {shown.map((s) => (
        <span class={`badge-pill audit-sev audit-sev-${s}`}>
          {findings[s]} {s}
        </span>
      ))}
    </span>
  );
};
