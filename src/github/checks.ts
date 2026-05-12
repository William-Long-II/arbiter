import { octokitFor } from './api.ts';

/**
 * One CI signal for a head commit. Unified shape across GitHub's two APIs:
 *  - check-runs (Actions and modern providers)
 *  - combined statuses (Travis, Jenkins, legacy providers)
 */
export type CheckSignal = {
  name: string;
  /** Conclusion-or-state, normalized into one of these buckets. */
  state: 'success' | 'failure' | 'pending' | 'neutral';
};

export type ChecksSummary = {
  /** True iff at least one signal is in the 'failure' bucket. */
  anyFailing: boolean;
  /** True iff every signal that has a terminal state is success. */
  allPassing: boolean;
  /** True iff at least one check-run / status was returned. */
  hasAny: boolean;
  signals: CheckSignal[];
};

const TERMINAL = new Set(['success', 'failure', 'neutral']);

function bucketCheckRunConclusion(c: string | null | undefined): CheckSignal['state'] {
  switch (c) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'cancelled':
      return 'failure';
    case 'skipped':
    case 'neutral':
      return 'neutral';
    default:
      return 'pending';
  }
}

function bucketStatusState(s: string): CheckSignal['state'] {
  switch (s) {
    case 'success':
      return 'success';
    case 'failure':
    case 'error':
      return 'failure';
    case 'pending':
      return 'pending';
    default:
      return 'pending';
  }
}

/**
 * Fetch every CI signal for the given head SHA and normalize it into a
 * single summary. Combines GitHub's two APIs (check-runs + combined
 * statuses) so we don't miss either modern Actions checks or legacy
 * status-API providers.
 *
 * Errors are not propagated — a flaky checks API shouldn't block the
 * review. Callers receive an empty summary and can render the review
 * without CI context.
 */
export async function fetchChecksSummary(
  token: string,
  repoFull: string,
  sha: string,
): Promise<ChecksSummary> {
  const empty: ChecksSummary = {
    anyFailing: false,
    allPassing: true,
    hasAny: false,
    signals: [],
  };
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) return empty;

  const octokit = octokitFor(token);
  const signals: CheckSignal[] = [];

  try {
    const res = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: sha,
      per_page: 100,
    });
    for (const run of res.data.check_runs) {
      signals.push({
        name: run.name,
        state:
          run.status === 'completed'
            ? bucketCheckRunConclusion(run.conclusion)
            : 'pending',
      });
    }
  } catch {
    // Swallow — we'd rather review without CI than fail the whole job.
  }

  try {
    const res = await octokit.rest.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: sha,
      per_page: 100,
    });
    for (const s of res.data.statuses) {
      signals.push({
        name: s.context,
        state: bucketStatusState(s.state),
      });
    }
  } catch {
    // Same as above.
  }

  if (signals.length === 0) return empty;

  const anyFailing = signals.some((s) => s.state === 'failure');
  const allPassing =
    signals.filter((s) => TERMINAL.has(s.state)).every((s) => s.state === 'success') &&
    signals.some((s) => s.state === 'success');

  return { anyFailing, allPassing, hasAny: true, signals };
}

/**
 * Render the summary as a Markdown block to inline into the user message
 * for the reviewer. Returns null when there are no signals (so the prompt
 * can omit the section entirely).
 */
export function formatChecksSummary(summary: ChecksSummary): string | null {
  if (!summary.hasAny) return null;

  const failing = summary.signals.filter((s) => s.state === 'failure').map((s) => s.name);
  const pending = summary.signals.filter((s) => s.state === 'pending').map((s) => s.name);
  const passing = summary.signals.filter((s) => s.state === 'success').map((s) => s.name);
  const neutral = summary.signals.filter((s) => s.state === 'neutral').map((s) => s.name);

  const lines: string[] = ['## CI status'];
  if (failing.length > 0) lines.push(`- Failing (${failing.length}): ${failing.join(', ')}`);
  if (pending.length > 0) lines.push(`- Pending (${pending.length}): ${pending.join(', ')}`);
  if (passing.length > 0) lines.push(`- Passing (${passing.length}): ${passing.join(', ')}`);
  if (neutral.length > 0) lines.push(`- Skipped/neutral (${neutral.length}): ${neutral.join(', ')}`);
  return lines.join('\n');
}
