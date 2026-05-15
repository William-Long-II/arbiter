import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import type { PendingReview, ReviewStatus } from '../../db/reviews.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  reviews: PendingReview[];
  /** Active filter from the URL. Empty = "all statuses". */
  statusFilter?: ReviewStatus[];
};

const FILTER_CHIPS: { status: ReviewStatus | null; label: string }[] = [
  { status: null, label: 'All' },
  { status: 'queued', label: 'Queued' },
  { status: 'running', label: 'Running' },
  { status: 'failed', label: 'Failed' },
  { status: 'done', label: 'Done' },
];

export const QueuePage: FC<Props> = ({ user, reviews, statusFilter = [] }) => {
  const active = new Set(statusFilter);
  const isAll = active.size === 0;
  return (
    <Layout title="Queue" user={user} active="queue">
      <header class="page-header">
        <h1>Queue</h1>
        <p class="page-subhead">
          PR reviews waiting to run, in flight, or recently completed.
        </p>
      </header>

      <nav class="queue-filter-row">
        {FILTER_CHIPS.map((chip) => {
          const isActive =
            chip.status === null ? isAll : active.has(chip.status) && active.size === 1;
          const href = chip.status === null ? '/queue' : `/queue?status=${chip.status}`;
          return (
            <a
              class={isActive ? 'queue-filter-chip active' : 'queue-filter-chip'}
              href={href}
            >
              {chip.label}
              {chip.status ? (
                <span class={`queue-filter-dot status-${chip.status}`} aria-hidden="true" />
              ) : null}
            </a>
          );
        })}
      </nav>

      {reviews.length === 0 ? (
        <div class="card empty-card">
          <p class="empty-card-title">
            {isAll ? 'No reviews yet.' : 'No reviews match this filter.'}
          </p>
          <p class="empty-card-body">
            {isAll ? (
              <>
                Reviews appear here once a scope matches a PR or you enqueue one
                manually via <code class="mono">POST /api/debug/enqueue-review</code>.
              </>
            ) : (
              <>
                <a class="text-link" href="/queue">Clear the filter</a> to see all reviews.
              </>
            )}
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
        SSE client + 1s ticker. SSE patches the row on every worker
        state/phase change (no polling — events only fire on a real
        commit, including the new setReviewPhase NOTIFY). The interval
        only animates the elapsed counter on running rows client-side;
        it issues no requests. EventSource auto-reconnects on drop.
      */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function() {
              if (typeof EventSource === 'undefined') return;
              function fmtElapsed(s) {
                if (s < 60) return s + 's';
                var m = Math.floor(s / 60);
                if (m < 60) return m + 'm ' + (s % 60) + 's';
                return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
              }
              function rel(iso) {
                var s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
                if (s < 60) return s + 's ago';
                if (s < 3600) return Math.floor(s/60) + 'm ago';
                if (s < 86400) return Math.floor(s/3600) + 'h ago';
                return Math.floor(s/86400) + 'd ago';
              }
              function renderTime(row) {
                var pill = row.querySelector('[data-status-pill]');
                var t = row.querySelector('[data-started]');
                if (!pill || !t) return;
                var st = t.getAttribute('data-started-at');
                if (pill.getAttribute('data-status') === 'running' && st) {
                  var e = fmtElapsed(Math.max(0, Math.floor((Date.now() - new Date(st).getTime()) / 1000)));
                  var ph = t.getAttribute('data-phase');
                  t.textContent = ph ? (ph + ' · ' + e) : e;
                } else {
                  t.textContent = st ? rel(st) : '—';
                }
              }
              function renderAll() {
                document.querySelectorAll('[data-review-id]').forEach(renderTime);
              }
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
                  var t = row.querySelector('[data-started]');
                  if (t) {
                    t.setAttribute('data-started-at', e.startedAt || '');
                    t.setAttribute('data-phase', (e.status === 'running' && e.phase) ? e.phase : '');
                  }
                  renderTime(row);
                } catch (err) { console.error('[sse]', err); }
              });
              renderAll();
              setInterval(renderAll, 1000);
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
      {review.status === 'queued' && review.deferUntil && review.deferUntil > new Date() ? (
        <span
          class="badge-pill badge-pill-muted queue-row-defer"
          title={`Waiting on CI · attempt ${review.deferCount} of 10 · next check ${formatFuture(review.deferUntil)}`}
        >
          waiting on CI
        </span>
      ) : null}
      <span
        class="queue-row-time"
        data-started
        data-started-at={review.startedAt ? new Date(review.startedAt).toISOString() : ''}
        data-phase={review.status === 'running' && review.phase ? review.phase : ''}
      >
        {timeCell(review)}
      </span>
      <a class="cta-tertiary queue-row-link" href={`/queue/${review.id}`}>View</a>
    </li>
  );
};

const StatusPill: FC<{ status: ReviewStatus }> = ({ status }) => {
  const cls = `badge-pill status-${status}`;
  return <span class={cls} data-status-pill data-status={status}>{status}</span>;
};

function formatFuture(d: Date | string): string {
  const then = new Date(d).getTime();
  const seconds = Math.max(0, Math.floor((then - Date.now()) / 1000));
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `in ${minutes}m`;
}

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

// Elapsed (counting up), not relative ("ago"). Kept byte-identical to the
// client-side fmtElapsed below so the server render and the 1s ticker
// never disagree.
export function fmtElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Initial text for the time/progress column. Running rows show
 * `phase · elapsed` (the ticker keeps elapsed live); everything else
 * keeps the existing "Xs ago" relative form.
 */
function timeCell(r: PendingReview): string {
  if (r.status === 'running' && r.startedAt) {
    const e = fmtElapsed(
      Math.max(0, Math.floor((Date.now() - new Date(r.startedAt).getTime()) / 1000)),
    );
    return r.phase ? `${r.phase} · ${e}` : e;
  }
  return r.startedAt ? formatRelative(r.startedAt) : '—';
}
