import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import type { PendingReview, ReviewStatus } from '../../db/reviews.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  reviews: PendingReview[];
};

export const QueuePage: FC<Props> = ({ user, reviews }) => {
  return (
    <Layout title="Queue" user={user} active="queue">
      <header class="page-header">
        <h1>Queue</h1>
        <p class="page-subhead">
          PR reviews waiting to run, in flight, or recently completed.
        </p>
      </header>

      {reviews.length === 0 ? (
        <div class="card empty-card">
          <p class="empty-card-title">No reviews yet.</p>
          <p class="empty-card-body">
            Reviews appear here once a scope matches a PR or you enqueue one
            manually via <code class="mono">POST /api/debug/enqueue-review</code>.
          </p>
        </div>
      ) : (
        <div class="card list-card queue-card">
          <div class="list-card-header queue-list-header">
            <span>PR</span>
            <span>Status</span>
            <span>Started</span>
            <span>{/* link column */}</span>
          </div>
          <ul class="row-list">
            {reviews.map((r) => (
              <QueueRow review={r} />
            ))}
          </ul>
        </div>
      )}

      {/*
        SSE client: subscribes to /api/events/queue and patches the DOM
        in place when a review's status changes. No polling — events
        only arrive when the worker actually commits a state change.
        EventSource auto-reconnects if the connection drops.
      */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function() {
              if (typeof EventSource === 'undefined') return;
              var es = new EventSource('/api/events/queue');
              es.addEventListener('review', function(ev) {
                try {
                  var e = JSON.parse(ev.data);
                  var row = document.querySelector('[data-review-id="' + e.reviewId + '"]');
                  if (!row) {
                    // New review we didn't render at page load — reload so
                    // the row appears with full meta (title, branches, etc.)
                    location.reload();
                    return;
                  }
                  var pill = row.querySelector('[data-status-pill]');
                  if (pill) {
                    pill.className = 'badge-pill status-' + e.status;
                    pill.textContent = e.status;
                    pill.setAttribute('data-status', e.status);
                  }
                  var started = row.querySelector('[data-started]');
                  if (started) started.textContent = e.startedAt ? rel(e.startedAt) : '—';
                } catch (err) { console.error('[sse]', err); }
              });
              function rel(iso) {
                var s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
                if (s < 60) return s + 's ago';
                if (s < 3600) return Math.floor(s/60) + 'm ago';
                if (s < 86400) return Math.floor(s/3600) + 'h ago';
                return Math.floor(s/86400) + 'd ago';
              }
            })();
          `,
        }}
      />
    </Layout>
  );
};

const QueueRow: FC<{ review: PendingReview }> = ({ review }) => {
  return (
    <li class="queue-row queue-list-row" data-review-id={review.id}>
      <div class="queue-row-pr">
        <span class="mono-sm queue-row-repo">{review.repoFull}</span>
        <span class="queue-row-prnum">#{review.prNumber}</span>
        <span class="queue-row-title">{review.prTitle}</span>
      </div>
      <StatusPill status={review.status} />
      <span class="queue-row-time" data-started>
        {review.startedAt ? formatRelative(review.startedAt) : '—'}
      </span>
      <a class="cta-tertiary queue-row-link" href={`/queue/${review.id}`}>View</a>
    </li>
  );
};

const StatusPill: FC<{ status: ReviewStatus }> = ({ status }) => {
  const cls = `badge-pill status-${status}`;
  return <span class={cls} data-status-pill data-status={status}>{status}</span>;
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
