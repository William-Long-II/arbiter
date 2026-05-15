import { config } from '../config.ts';
import { sql } from '../db.ts';
import { listScopes } from '../db/scopes.ts';
import { markTokenRevoked } from '../db/users.ts';
import { enqueueForUser } from '../enqueue.ts';
import {
  listOpenPullsForScopes,
  type ScopeTarget,
  type ScopedPR,
} from './pulls.ts';

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
// Observable state for the UI: when the next tick is expected and when the
// last one happened. Both are wall-clock; the client uses nextPollAt to run
// a local countdown without polling the server.
let nextPollAt: Date | null = null;
let lastTickAt: Date | null = null;

export function startPoller(): void {
  if (timer) return;
  const ms = config.pollIntervalSeconds * 1000;
  console.log(`[poller] starting, interval=${config.pollIntervalSeconds}s`);
  // Fire once on startup so we don't wait `interval` for the first poll.
  nextPollAt = new Date(Date.now() + 1000);
  setTimeout(() => { void tick(); }, 1000);
  timer = setInterval(() => { void tick(); }, ms);
}

export function stopPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  nextPollAt = null;
}

/**
 * Snapshot of the poller's wall-clock state. Used by the UI to render a
 * "next poll in Xs" countdown so the user isn't guessing when the next
 * sweep is. All three fields can be null before the poller starts.
 */
export type PollerStatus = {
  intervalSeconds: number;
  nextPollAt: string | null;
  lastTickAt: string | null;
  inFlight: boolean;
};

export function getPollerStatus(): PollerStatus {
  return {
    intervalSeconds: config.pollIntervalSeconds,
    nextPollAt: nextPollAt ? nextPollAt.toISOString() : null,
    lastTickAt: lastTickAt ? lastTickAt.toISOString() : null,
    inFlight,
  };
}

/**
 * One poll tick:
 *  1. Find every user that has at least one enabled scope.
 *  2. For each user, list open PRs in one GraphQL query (or two if some
 *     scopes opted into `review_requested` trigger mode) covering every
 *     target the user watches. Per-target REST fan-out is gone.
 *  3. Match each PR against the user's scope rules — first matching rule
 *     wins (matchScope). If the matched scope is `review_requested` mode,
 *     drop the PR unless GitHub's `review-requested:@me` half of the
 *     search returned it.
 *  4. Enqueue. enqueueReview is idempotent on (repo, pr#, head_sha) so
 *     polling repeatedly is safe — the queue only grows on new shas.
 */
async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const started = Date.now();
  lastTickAt = new Date(started);
  // Compute the *next* expected tick as soon as this one starts running, so
  // the UI's countdown stays in step with setInterval rather than drifting
  // by however long this tick takes.
  nextPollAt = new Date(started + config.pollIntervalSeconds * 1000);
  let enqueued = 0;
  try {
    const users = await sql<{ id: number; login: string; token: string }[]>`
      SELECT DISTINCT u.id, u.github_login AS login, u.github_token AS token
      FROM users u
      JOIN scopes s ON s.user_id = u.id
      WHERE s.enabled = TRUE
    `;
    for (const user of users) {
      try {
        enqueued += await pollUser(user);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[poller] user ${user.login}: ${message}`);
      }
    }
  } catch (err) {
    console.error('[poller] tick error:', err);
  } finally {
    inFlight = false;
    if (enqueued > 0) {
      console.log(`[poller] tick complete, ${enqueued} enqueued in ${Date.now() - started}ms`);
    }
  }
}

async function pollUser(user: {
  id: number;
  login: string;
  token: string;
}): Promise<number> {
  const scopes = (await listScopes(user.id)).filter((s) => s.enabled);
  if (scopes.length === 0) return 0;

  // Split targets by which trigger-mode batch they belong to. A target can
  // show up in both lists if the user has e.g. two scopes on the same org
  // with different trigger modes — that's fine; listOpenPullsForScopes
  // dedupes the returned PRs by (repo, number) and keeps the
  // reviewRequestedForViewer flag sticky.
  const openTargets = new Map<string, ScopeTarget>();
  const reviewRequestedTargets = new Map<string, ScopeTarget>();
  for (const s of scopes) {
    const key = `${s.targetKind}:${s.target}`;
    const entry: ScopeTarget = { kind: s.targetKind, target: s.target };
    if (s.triggerMode === 'review_requested') {
      reviewRequestedTargets.set(key, entry);
    } else {
      openTargets.set(key, entry);
    }
  }

  let prs: ScopedPR[];
  try {
    prs = await listOpenPullsForScopes(
      user.token,
      [...openTargets.values()],
      [...reviewRequestedTargets.values()],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Same 401 detection the worker uses. A revoked token will hit this
    // on every poll until the user re-auths; mark them so the banner
    // shows up. We don't `return` — other users still get polled.
    if (isUnauthorized(err)) {
      await markTokenRevoked(user.id);
      console.error(`[poller] user ${user.login} GitHub token revoked — banner will prompt re-auth`);
      return 0;
    }
    console.error(`[poller] list for ${user.login}: ${message}`);
    return 0;
  }

  let enqueued = 0;
  for (const pr of prs) {
    // Shared with the webhook receiver: same auto-merge / scope-match /
    // trigger-mode filtering and scope-snapshot mapping. See src/enqueue.ts.
    const { review, matched } = await enqueueForUser({
      userId: user.id,
      selfLogin: user.login,
      scopes,
      pr,
    });
    if (review && matched) {
      enqueued++;
      console.log(
        `[poller] enqueued #${review.id} ${pr.repoFull}#${pr.number} (scope ${matched.id}, scrutiny=${matched.scrutiny}, trigger=${matched.triggerMode})`,
      );
    }
  }
  return enqueued;
}

function isUnauthorized(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: unknown }).status;
  return status === 401;
}
