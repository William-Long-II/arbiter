import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import type { PendingReview, ReviewStatus } from '../../db/reviews.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  review: PendingReview;
};

export const QueueDetailPage: FC<Props> = ({ user, review }) => {
  const ghUrl = `https://github.com/${review.repoFull}/pull/${review.prNumber}`;
  return (
    <Layout title={`#${review.prNumber} ${review.prTitle}`} user={user} active="queue">
      <header class="page-header page-header-with-action">
        <div>
          <h1 class="queue-detail-title">
            <span class="mono-sm">{review.repoFull}</span>
            <span class="queue-detail-prnum">#{review.prNumber}</span>
          </h1>
          <p class="page-subhead queue-detail-subhead">{review.prTitle}</p>
        </div>
        <a class="cta-secondary" href={ghUrl} target="_blank" rel="noopener noreferrer">
          Open on GitHub ↗
        </a>
      </header>

      <div class="card queue-meta-card">
        <MetaRow label="Status">
          <span class={`badge-pill status-${review.status}`}>{review.status}</span>
        </MetaRow>
        <MetaRow label="Author">
          <span class="mono-sm">{review.prAuthor}</span>
        </MetaRow>
        <MetaRow label="Base → Head">
          <span class="mono-sm">{review.baseBranch}</span>
          <span class="queue-detail-arrow">→</span>
          <span class="mono-sm">{review.headBranch}</span>
        </MetaRow>
        <MetaRow label="Head SHA">
          <span class="mono-sm">{review.headSha.slice(0, 12)}</span>
        </MetaRow>
        <MetaRow label="Scrutiny">
          <span class={`badge-pill scrutiny-${review.scrutiny}`}>{review.scrutiny}</span>
        </MetaRow>
        <MetaRow label="Mode">
          <span class="mono-sm">{review.claudeMode}</span>
        </MetaRow>
        <MetaRow label="Auto-approve">
          <span>{review.autoApprove ? 'enabled' : 'disabled'}</span>
        </MetaRow>
        {review.verdict ? (
          <MetaRow label="Verdict">
            <span class={`badge-pill verdict-${review.verdict}`}>{review.verdict}</span>
          </MetaRow>
        ) : null}
        {review.postedEvent ? (
          <MetaRow label="Posted as">
            <span class="mono-sm">{review.postedEvent}</span>
          </MetaRow>
        ) : null}
        <MetaRow label="Attempts">
          <span>{review.attempt}</span>
        </MetaRow>
        <MetaRow label="Created">
          <span>{new Date(review.createdAt).toLocaleString()}</span>
        </MetaRow>
        {review.startedAt ? (
          <MetaRow label="Started">
            <span>{new Date(review.startedAt).toLocaleString()}</span>
          </MetaRow>
        ) : null}
        {review.finishedAt ? (
          <MetaRow label="Finished">
            <span>{new Date(review.finishedAt).toLocaleString()}</span>
          </MetaRow>
        ) : null}
      </div>

      {review.error ? (
        <section class="queue-output-section">
          <h2 class="queue-output-title queue-output-title-error">Error</h2>
          <pre class="code-window queue-output-pre">{review.error}</pre>
        </section>
      ) : null}

      {review.output ? (
        <section class="queue-output-section">
          <h2 class="queue-output-title">Posted review</h2>
          <pre class="code-window queue-output-pre">{review.output}</pre>
        </section>
      ) : !review.error ? (
        <section class="queue-output-section">
          <p class="page-subhead">
            {review.status === 'queued'
              ? 'Waiting in queue. The worker will pick it up shortly.'
              : 'Running…'}
          </p>
        </section>
      ) : null}

      {/*
        SSE client: while this review is still active (queued or running),
        listen for state changes on the same SSE stream. When THIS review
        flips to a terminal state, full-reload so the rendered output /
        error / posted-event meta all show.

        No polling — we only reload when the worker actually commits.
      */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function() {
              var status = ${JSON.stringify(review.status)};
              var id = ${JSON.stringify(review.id)};
              var TERMINAL = { done: 1, failed: 1, skipped: 1 };
              if (TERMINAL[status] || typeof EventSource === 'undefined') return;
              var es = new EventSource('/api/events/queue');
              es.addEventListener('review', function(ev) {
                try {
                  var e = JSON.parse(ev.data);
                  if (e.reviewId !== id) return;
                  if (TERMINAL[e.status]) {
                    es.close();
                    location.reload();
                  }
                } catch (err) { console.error('[sse]', err); }
              });
            })();
          `,
        }}
      />
    </Layout>
  );
};

const MetaRow: FC<{ label: string; children: unknown }> = ({ label, children }) => {
  return (
    <div class="queue-meta-row">
      <span class="queue-meta-label">{label}</span>
      <span class="queue-meta-value">{children}</span>
    </div>
  );
};
