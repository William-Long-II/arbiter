import type { FC } from 'hono/jsx';
import type { User } from '../../db/users.ts';
import type { PendingReview } from '../../db/reviews.ts';
import { Layout } from './layout.tsx';

type Props = {
  user: User;
  /** The review being re-run. Its snapshotted settings prefill the form. */
  review: PendingReview;
  /** Optional inline error from a failed re-review attempt. */
  error?: string;
};

/**
 * Manual re-review form. Prefilled with the source review's settings so the
 * common case ("run that again") is one click, while scrutiny / context /
 * mode / personality stay editable for "the review was weak — try harder".
 * Submitting POSTs to /queue/:id/re-review, which re-fetches the live PR and
 * enqueues a fresh `trigger=manual` row (exempt from head-SHA idempotency).
 */
export const ReReviewPage: FC<Props> = ({ user, review, error }) => {
  const action = `/queue/${review.id}/re-review`;
  return (
    <Layout title={`Re-review #${review.prNumber}`} user={user} active="queue">
      <header class="page-header page-header-with-action">
        <div>
          <h1 class="queue-detail-title">
            Re-review <span class="queue-detail-prnum">#{review.prNumber}</span>
          </h1>
          <p class="page-subhead queue-detail-subhead">
            <span class="mono-sm">{review.repoFull}</span> · {review.prTitle}
          </p>
        </div>
        <a class="cta-secondary" href={`/queue/${review.id}`}>← Back to review</a>
      </header>

      {error ? (
        <div class="form-errors">
          <strong>Couldn't re-review:</strong> {error}
        </div>
      ) : null}

      <p class="page-subhead">
        Runs a fresh review against the PR's <strong>current</strong> head
        commit and keeps the previous run as history. Settings below start
        from the last run — raise scrutiny or switch context to dig deeper.
      </p>

      <form class="form" method="post" action={action}>
        <fieldset class="form-row">
          <legend>Scrutiny</legend>
          <select class="text-input form-input-wide" name="scrutiny">
            <option value="light" selected={review.scrutiny === 'light'}>light</option>
            <option value="standard" selected={review.scrutiny === 'standard'}>standard</option>
            <option value="strict" selected={review.scrutiny === 'strict'}>strict</option>
          </select>
        </fieldset>

        <fieldset class="form-row">
          <legend>Review context</legend>
          <select class="text-input form-input-wide" name="review_context">
            <option value="isolated" selected={review.reviewContext === 'isolated'}>
              isolated (diff only)
            </option>
            <option value="checkout" selected={review.reviewContext === 'checkout'}>
              checkout (full repo working tree)
            </option>
          </select>
        </fieldset>

        <fieldset class="form-row">
          <legend>Mode</legend>
          <select class="text-input form-input-wide" name="claude_mode">
            <option value="subscription" selected={review.claudeMode === 'subscription'}>
              subscription
            </option>
            <option value="api" selected={review.claudeMode === 'api'}>api</option>
          </select>
        </fieldset>

        <fieldset class="form-row">
          <legend>Reviewer personality (optional)</legend>
          <textarea
            class="text-input form-textarea"
            name="personality_prompt"
            rows={4}
            placeholder="Voice / focus for the reviewer. Leave blank for the default."
          >{review.personalityPrompt ?? ''}</textarea>
          <p class="form-hint">
            Prefilled from the original run. Appended to the scrutiny tier's
            system prompt; leave blank for default behavior.
          </p>
          <label class="checkbox" style="margin-top: 0.5rem;">
            <input type="checkbox" name="humanize" checked={review.humanize} />
            <span>
              Rewrite output in this voice (second LLM call, ~2x latency and cost)
            </span>
          </label>
        </fieldset>

        <fieldset class="form-row">
          <label class="checkbox">
            <input type="checkbox" name="auto_approve" checked={review.autoApprove} />
            <span>Auto-approve when the verdict is clean</span>
          </label>
        </fieldset>

        <fieldset class="form-row">
          <label class="checkbox">
            <input type="checkbox" name="incremental" checked />
            <span>Incremental — review only the changes since the last completed review</span>
          </label>
          <p class="form-hint">
            Much cheaper and faster on iterating PRs. The prior review is given
            to the model as context and the verdict still covers the whole PR.
            Falls back to a full review automatically when there is no prior
            completed review, the head is unchanged, or the branch was
            rebased/merged-into since.
          </p>
        </fieldset>

        <p class="form-hint">
          Footer template, gate-on-blocking and reviewer skill are carried
          over from the original run unchanged.
        </p>

        <div class="form-actions">
          <button class="cta-primary" type="submit">↻ Run re-review</button>
          <a class="cta-secondary" href={`/queue/${review.id}`}>Cancel</a>
        </div>
      </form>
    </Layout>
  );
};
