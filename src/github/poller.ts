import { config } from '../config.ts';
import { sql } from '../db.ts';
import { listScopes, type Scope } from '../db/scopes.ts';
import { enqueueReview } from '../db/reviews.ts';
import { markTokenRevoked } from '../db/users.ts';
import { matchScope } from '../scope.ts';
import {
  listOpenPullsForOrg,
  listOpenPullsForRepo,
  type PRDetails,
} from './pulls.ts';

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startPoller(): void {
  if (timer) return;
  const ms = config.pollIntervalSeconds * 1000;
  console.log(`[poller] starting, interval=${config.pollIntervalSeconds}s`);
  // Fire once on startup so we don't wait `interval` for the first poll.
  setTimeout(() => { void tick(); }, 1000);
  timer = setInterval(() => { void tick(); }, ms);
}

export function stopPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * One poll tick:
 *  1. Find every user that has at least one enabled scope.
 *  2. For each user, fetch their enabled scopes and list open PRs from
 *     each unique target (one search call per org; one list call per repo).
 *  3. Match each PR against the user's scope rules — first matching rule
 *     wins (matchScope).
 *  4. Enqueue. enqueueReview is idempotent on (repo, pr#, head_sha) so
 *     polling repeatedly is safe — the queue only grows on new shas.
 */
async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const started = Date.now();
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

  // Dedupe by target — multiple scopes can target the same repo or org
  // (e.g., one rule for main with strict, one for release/* with standard).
  // We list PRs once per target and then run matchScope against the full
  // bundle of rules for that target.
  const byTarget = new Map<string, Scope[]>();
  for (const s of scopes) {
    const key = `${s.targetKind}:${s.target}`;
    const arr = byTarget.get(key) ?? [];
    arr.push(s);
    byTarget.set(key, arr);
  }

  let enqueued = 0;
  for (const [key, rules] of byTarget.entries()) {
    const first = rules[0]!;
    let prs: PRDetails[];
    try {
      prs = first.targetKind === 'repo'
        ? await listOpenPullsForRepo(user.token, first.target)
        : await listOpenPullsForOrg(user.token, first.target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Same 401 detection the worker uses. A revoked token will hit this
      // on every poll until the user re-auths; mark them so the banner
      // shows up. We don't `return` — other users still get polled.
      if (isUnauthorized(err)) {
        await markTokenRevoked(user.id);
        console.error(`[poller] user ${user.login} GitHub token revoked — banner will prompt re-auth`);
        return enqueued;
      }
      console.error(`[poller] list ${key}: ${message}`);
      continue;
    }

    for (const pr of prs) {
      // Skip PRs configured for auto-merge — the author has already
      // committed to "merge when ready"; a generated review is wasted
      // effort and may post comments to a PR that's about to disappear.
      if (pr.autoMerge) continue;
      const matched = matchScope(pr, rules, user.login);
      if (!matched) continue;
      const claudeMode =
        matched.claudeMode === 'default'
          ? config.claude.defaultMode
          : matched.claudeMode;
      const row = await enqueueReview({
        userId: user.id,
        scopeId: matched.id,
        repoFull: pr.repoFull,
        prNumber: pr.number,
        prTitle: pr.title,
        prAuthor: pr.author,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        headSha: pr.headSha,
        scrutiny: matched.scrutiny,
        claudeMode,
        autoApprove: matched.autoApprove,
        footerTemplate: matched.footerTemplate,
      });
      if (row) {
        enqueued++;
        console.log(
          `[poller] enqueued #${row.id} ${pr.repoFull}#${pr.number} (scope ${matched.id}, scrutiny=${matched.scrutiny})`,
        );
      }
    }
  }
  return enqueued;
}

function isUnauthorized(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const status = (err as { status?: unknown }).status;
  return status === 401;
}
