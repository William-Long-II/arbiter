// Pure review-outcome policy: which GitHub review event to post, and the
// commit-status that mirrors it. No I/O — unit-tested. Keeps the
// "deliberately non-aggressive by default" rule in one place: REQUEST_
// CHANGES only happens when a scope explicitly opted into gate_on_blocking.

import type { FindingCounts, FindingItem, Verdict } from './format.ts';

export type ReviewEventChoice = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

/** A review "has blockers" if the model said request-changes OR reported
 *  ≥1 blocking finding. Either signal alone is enough (the model may emit
 *  one marker and forget the other). */
export function hasBlocking(
  verdict: Verdict,
  findings: FindingCounts | null | undefined,
): boolean {
  return verdict === 'request-changes' || (findings?.blocking ?? 0) > 0;
}

/**
 * Decide the GitHub review event.
 * - Auto-approve is a commitment to a BINARY outcome: the scope asked
 *   arbiter to actually resolve the review, so a non-`approve` verdict —
 *   including the `comment` fallback when the model omits the marker —
 *   posts as REQUEST_CHANGES. A verdict-less drive-by COMMENT on an
 *   auto-approve scope reads as "approved-ish" while approving nothing.
 * - REQUEST_CHANGES (without auto-approve): scope opted into
 *   gate-on-blocking and there are blockers.
 * - COMMENT otherwise — every scope that didn't opt in (the unchanged,
 *   deliberately non-aggressive default), and always on your own PR
 *   (GitHub forbids reviewing your own PR with a state).
 */
export function pickReviewEvent(args: {
  autoApprove: boolean;
  gateOnBlocking: boolean;
  verdict: Verdict;
  findings: FindingCounts | null | undefined;
  prAuthor: string;
  reviewerLogin: string;
}): ReviewEventChoice {
  const isSelf =
    args.prAuthor.toLowerCase() === args.reviewerLogin.toLowerCase();
  if (args.autoApprove && !isSelf) {
    return args.verdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES';
  }
  if (
    args.gateOnBlocking &&
    !isSelf &&
    hasBlocking(args.verdict, args.findings)
  ) {
    return 'REQUEST_CHANGES';
  }
  return 'COMMENT';
}

/**
 * Which findings deserve their own inline thread, given the review event
 * being posted. On APPROVE, minor/nit findings stay in the summary body
 * only: every inline comment opens a conversation, and repos with
 * "require conversation resolution" (ruleset or branch protection) turn
 * each one into a merge blocker — on a PR the reviewer just approved.
 * COMMENT and REQUEST_CHANGES keep everything inline; there the threads
 * are the point.
 */
export function selectInlineFindings(
  items: FindingItem[],
  event: ReviewEventChoice,
): { items: FindingItem[]; suppressed: number } {
  if (event !== 'APPROVE') return { items, suppressed: 0 };
  const kept = items.filter(
    (it) => it.severity === 'blocking' || it.severity === 'major',
  );
  return { items: kept, suppressed: items.length - kept.length };
}

export type CommitStatusState = 'success' | 'failure';

/** GitHub caps status `description` at 140 chars. */
function clamp(s: string): string {
  return s.length <= 140 ? s : s.slice(0, 137) + '…';
}

/**
 * The commit status mirroring a gated review: `failure` when there are
 * blockers (so a required check blocks merge), else `success`. Pure;
 * the worker only calls this when the scope opted into gating.
 */
export function statusForReview(args: {
  verdict: Verdict;
  findings: FindingCounts | null | undefined;
}): { state: CommitStatusState; description: string } {
  const f = args.findings ?? null;
  if (hasBlocking(args.verdict, f)) {
    const n = f?.blocking ?? 0;
    return {
      state: 'failure',
      description: clamp(
        n > 0
          ? `${n} blocking finding${n === 1 ? '' : 's'} — changes requested`
          : 'Blocking issues — changes requested',
      ),
    };
  }
  const extra = f
    ? ` (major ${f.major}, minor ${f.minor}, nit ${f.nit})`
    : '';
  return {
    state: 'success',
    description: clamp(`No blocking findings${extra}`),
  };
}
