import type { FC } from 'hono/jsx';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import type { User } from '../../db/users.ts';
import type { PendingReview, ReviewOverride, ReviewStatus } from '../../db/reviews.ts';
import { Layout } from './layout.tsx';
import { fmtElapsed, fmtCostUsd } from './queue-list.tsx';

/** Initial "phase · elapsed" text for a running review (the 1s ticker
 * keeps elapsed live thereafter). Empty for non-running rows. */
export function detailProgress(r: PendingReview): string {
  if (r.status !== 'running' || !r.startedAt) return '';
  const e = fmtElapsed(
    Math.max(0, Math.floor((Date.now() - new Date(r.startedAt).getTime()) / 1000)),
  );
  return r.phase ? `${r.phase} · ${e}` : e;
}

// Configure marked once. GFM extensions (tables, strikethrough, etc.) match
// what GitHub will render.
marked.setOptions({ gfm: true, breaks: false });

// The review body is model output produced from a third-party PR diff
// (reviewing other people's PRs is the whole point), so it is NOT trusted
// HTML. GitHub renders the same text through its own sanitizer; we must do
// the equivalent before dangerouslySetInnerHTML or a crafted PR can land
// active content in the operator's authenticated session. Allowlist is the
// tag/attribute set GFM markdown actually emits — anything else (script,
// event handlers, javascript: URLs, raw style) is discarded.
function renderReviewMarkdown(md: string): string {
  const html = marked.parse(md) as string;
  return sanitizeHtml(html, {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'ul', 'ol', 'li',
      'blockquote', 'code', 'pre', 'em', 'strong', 'del', 'hr', 'br',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'span',
    ],
    allowedAttributes: {
      a: ['href', 'title'],
      img: ['src', 'alt', 'title'],
      th: ['align'],
      td: ['align'],
      code: ['class'],
      span: ['class'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    disallowedTagsMode: 'discard',
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', {
        rel: 'noopener nofollow ugc',
        target: '_blank',
      }),
    },
  });
}

type Props = {
  user: User;
  review: PendingReview;
  /** Other reviews for the same (repo, pr_number) — see listReviewsForPR. */
  siblings?: PendingReview[];
  /** Present if the user already pressed "Approve anyway" on this row. */
  override?: ReviewOverride | null;
};

export const QueueDetailPage: FC<Props> = ({
  user,
  review,
  siblings = [],
  override = null,
}) => {
  const ghUrl = `https://github.com/${review.repoFull}/pull/${review.prNumber}`;
  const isSelfAuthor =
    review.prAuthor.toLowerCase() === user.githubLogin.toLowerCase();
  // The button only makes sense for terminal, non-APPROVE rows on a PR
  // the current user can actually approve on GitHub.
  const canApproveAnyway =
    review.status === 'done' &&
    review.postedEvent !== 'APPROVE' &&
    !isSelfAuthor &&
    !override;
  // A review skipped because the PR conversation was locked: the body was
  // generated and preserved (output set) so it can still be posted once
  // the user unlocks the PR. Structural skips have output === null.
  const isPendingPost =
    review.status === 'skipped' &&
    !!review.output &&
    !!review.verdict &&
    !!review.postedEvent;
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
        <div class="page-header-actions">
          {/* Re-review re-runs against the PR's current head; only meaningful
              once this run has reached a terminal state. */}
          {review.status === 'done' ||
          review.status === 'failed' ||
          review.status === 'skipped' ? (
            <a class="cta-secondary" href={`/queue/${review.id}/re-review`}>
              ↻ Re-review
            </a>
          ) : null}
          <a class="cta-secondary" href={ghUrl} target="_blank" rel="noopener noreferrer">
            Open on GitHub ↗
          </a>
        </div>
      </header>

      <div class="card queue-meta-card">
        <MetaRow label="Status">
          <span
            class={`badge-pill status-${review.status}`}
            data-status-pill
            data-status={review.status}
          >
            {review.status}
          </span>
          {/* Live phase · elapsed while running. Always rendered (empty
              when not running) so the SSE handler can fill it in on a
              queued→running transition without a reload. */}
          <span
            class="queue-detail-phase mono-sm"
            data-detail-progress
            data-started-at={
              review.startedAt ? new Date(review.startedAt).toISOString() : ''
            }
            data-phase={review.status === 'running' && review.phase ? review.phase : ''}
          >
            {detailProgress(review)}
          </span>
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
        {review.reviewerSkill ? (
          <MetaRow label="Reviewer">
            <span class="mono-sm">skill: /{review.reviewerSkill}</span>
          </MetaRow>
        ) : null}
        {review.costUsd != null ? (
          <MetaRow label="Cost">
            <span class="mono-sm">{fmtCostUsd(review.costUsd)}</span>
          </MetaRow>
        ) : null}
        {review.findings ? (
          <MetaRow label="Findings">
            <span class="mono-sm">
              blocking {review.findings.blocking} · major {review.findings.major}{' '}
              · minor {review.findings.minor} · nit {review.findings.nit}
            </span>
          </MetaRow>
        ) : null}
        <MetaRow label="Review context">
          <span class="mono-sm">{review.reviewContext}</span>
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
            {override ? (
              <span class="badge-pill verdict-approve queue-override-tag">
                + APPROVE override
              </span>
            ) : null}
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

      {review.prompts && review.prompts.length > 0 ? (
        <details class="queue-output-section queue-prompts-section">
          <summary class="queue-prompts-summary">
            Prompts used <span class="queue-siblings-count">({review.prompts.length})</span>
          </summary>
          <p class="page-subhead queue-prompts-hint">
            The system prompt(s) actually sent to the reviewer. Captured
            after assembly (scrutiny tier + context + personality, or the
            skill wrapper) so you can see and tune what the model saw.
          </p>
          {review.prompts.map((p) => (
            <div class="queue-prompt-entry">
              <div class="queue-prompt-label mono-sm">{p.label}</div>
              <pre class="code-window queue-output-pre queue-prompt-pre">{p.prompt}</pre>
            </div>
          ))}
        </details>
      ) : null}

      {override ? (
        <section class="queue-output-section queue-override-section">
          <h2 class="queue-output-title">Manual approval override</h2>
          <p class="page-subhead queue-override-hint">
            You posted an APPROVE on{' '}
            <span class="mono-sm">
              {new Date(override.postedAt).toLocaleString()}
            </span>{' '}
            despite the prior automated review.
          </p>
          {override.reason ? (
            <blockquote class="queue-override-reason">{override.reason}</blockquote>
          ) : (
            <p class="form-hint queue-override-hint">
              No reason recorded. (Approve-anyway accepts an optional note that
              helps tune future "issue vs suggestion" calls.)
            </p>
          )}
        </section>
      ) : canApproveAnyway ? (
        <section class="queue-output-section queue-override-section">
          <h2 class="queue-output-title">Approve anyway</h2>
          <p class="page-subhead queue-override-hint">
            The automated review was posted as{' '}
            <code class="mono-sm">{review.postedEvent ?? 'COMMENT'}</code>
            {review.verdict && review.verdict !== 'approve'
              ? ' because the verdict was '
              : null}
            {review.verdict && review.verdict !== 'approve' ? (
              <code class="mono-sm">{review.verdict}</code>
            ) : null}
            . If the flagged item is actually a suggestion (not a blocker),
            you can post an <code class="mono-sm">APPROVE</code> on GitHub
            yourself. The reason, if you leave one, is kept alongside this
            review as guidance for tuning future "issue vs suggestion" calls.
          </p>
          <form
            method="post"
            action={`/queue/${review.id}/approve-anyway`}
            class="queue-override-form"
          >
            <label class="queue-override-label" for="approve-anyway-reason">
              Reason (optional)
            </label>
            <textarea
              id="approve-anyway-reason"
              name="reason"
              class="queue-override-textarea"
              rows={3}
              maxLength={2000}
              placeholder="e.g. the flagged unused-var is intentional scaffolding"
            />
            <button class="cta-primary" type="submit">
              Approve PR anyway
            </button>
          </form>
        </section>
      ) : review.status === 'done' &&
        review.postedEvent !== 'APPROVE' &&
        isSelfAuthor ? (
        <section class="queue-output-section queue-override-section">
          <p class="form-hint">
            GitHub doesn't allow approving your own pull request, so the
            approve-anyway override isn't available here.
          </p>
        </section>
      ) : null}

      {isPendingPost ? (
        <section class="queue-output-section queue-override-section">
          <h2 class="queue-output-title">Post anyway</h2>
          <p class="page-subhead queue-override-hint">
            This review was generated but not posted because the pull
            request conversation was locked. Unlock it on{' '}
            <a href={ghUrl} target="_blank" rel="noreferrer">
              GitHub
            </a>
            , then post the saved review below as{' '}
            <code class="mono-sm">{review.postedEvent}</code>.
          </p>
          <form
            method="post"
            action={`/queue/${review.id}/post-anyway`}
            class="queue-override-form"
          >
            <button class="cta-primary" type="submit">
              Post saved review to GitHub
            </button>
          </form>
        </section>
      ) : null}

      {review.error ? (
        <section class="queue-output-section">
          <div class="queue-output-header">
            <h2
              class={
                isPendingPost
                  ? 'queue-output-title'
                  : 'queue-output-title queue-output-title-error'
              }
            >
              {isPendingPost ? 'Why this was skipped' : 'Error'}
            </h2>
            {review.status === 'failed' ? (
              <form method="post" action={`/queue/${review.id}/retry`}>
                <button class="cta-secondary" type="submit">
                  ↻ Retry this review
                </button>
              </form>
            ) : null}
          </div>
          <pre class="code-window queue-output-pre">{review.error}</pre>
          {review.status === 'failed' ? (
            <p class="form-hint queue-retry-hint">
              Retrying resets this row to <code class="mono-sm">queued</code> with the same
              head SHA and clears the error. The worker picks it up within ~10ms via the
              existing NOTIFY channel.
            </p>
          ) : null}
        </section>
      ) : null}

      {review.output ? (
        <section class="queue-output-section">
          <h2 class="queue-output-title">
            {isPendingPost ? 'Generated review (not posted yet)' : 'Posted review'}
          </h2>
          <div
            class="md-output"
            dangerouslySetInnerHTML={{ __html: renderReviewMarkdown(review.output) }}
          />
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

      {siblings.length > 0 ? (
        <section class="queue-output-section">
          <h2 class="queue-output-title">
            Prior runs on this PR <span class="queue-siblings-count">({siblings.length})</span>
          </h2>
          <p class="page-subhead queue-siblings-hint">
            Other reviews this user has run against{' '}
            <code class="mono-sm">{review.repoFull}#{review.prNumber}</code>{' '}
            — earlier head SHAs and any manual re-reviews.
          </p>
          <ul class="row-list queue-siblings">
            {siblings.map((s) => (
              <SiblingRow review={s} />
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        SSE client: while this review is active, live-update the status
        badge and the "phase · elapsed" progress (same stream + payload
        the queue list uses), and tick elapsed every second. When THIS
        review flips to a terminal state, full-reload so the rendered
        output / error / posted-event meta all show.

        No polling — SSE drives state; the 1s timer only re-renders the
        elapsed counter from data attributes.
      */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function() {
              var status = ${JSON.stringify(review.status)};
              var id = ${JSON.stringify(review.id)};
              var TERMINAL = { done: 1, failed: 1, skipped: 1 };
              // Byte-identical to fmtElapsed() server-side so the SSR text
              // and the ticker never disagree.
              function fmtElapsed(s) {
                if (s < 60) return s + 's';
                var m = Math.floor(s / 60);
                if (m < 60) return m + 'm ' + (s % 60) + 's';
                return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
              }
              function tick() {
                var pill = document.querySelector('[data-status-pill]');
                var prog = document.querySelector('[data-detail-progress]');
                if (!pill || !prog) return;
                if (pill.getAttribute('data-status') !== 'running') {
                  prog.textContent = '';
                  return;
                }
                var st = prog.getAttribute('data-started-at');
                if (!st) { prog.textContent = ''; return; }
                var e = fmtElapsed(Math.max(0, Math.floor(
                  (Date.now() - new Date(st).getTime()) / 1000)));
                var ph = prog.getAttribute('data-phase');
                prog.textContent = ph ? (ph + ' · ' + e) : e;
              }
              if (typeof EventSource !== 'undefined' && !TERMINAL[status]) {
                var es = new EventSource('/api/events/queue');
                es.addEventListener('review', function(ev) {
                  try {
                    var e = JSON.parse(ev.data);
                    if (e.reviewId !== id) return;
                    if (TERMINAL[e.status]) {
                      es.close();
                      location.reload();
                      return;
                    }
                    var pill = document.querySelector('[data-status-pill]');
                    if (pill) {
                      pill.className = 'badge-pill status-' + e.status;
                      pill.textContent = e.status;
                      pill.setAttribute('data-status', e.status);
                    }
                    var prog = document.querySelector('[data-detail-progress]');
                    if (prog) {
                      prog.setAttribute('data-phase',
                        (e.status === 'running' && e.phase) ? e.phase : '');
                      if (e.startedAt) prog.setAttribute('data-started-at', e.startedAt);
                    }
                    tick();
                  } catch (err) { console.error('[sse]', err); }
                });
              }
              setInterval(tick, 1000);
              tick();
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

const SiblingRow: FC<{ review: PendingReview }> = ({ review }) => {
  return (
    <li class="queue-sibling-row">
      <a href={`/queue/${review.id}`} class="queue-sibling-link">
        <span class={`badge-pill status-${review.status}`}>{review.status}</span>
        <span class="mono-sm queue-sibling-sha">{review.headSha.slice(0, 8)}</span>
        {review.triggerSource === 'manual' ? (
          <span class="badge-pill badge-pill-muted">re-review</span>
        ) : null}
        {review.verdict ? (
          <span class={`badge-pill verdict-${review.verdict}`}>{review.verdict}</span>
        ) : null}
        <span class="ink-subtle queue-sibling-time">
          {new Date(review.createdAt).toLocaleString()}
        </span>
      </a>
    </li>
  );
};
