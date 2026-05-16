// Postgres-backed integration coverage for the concurrency-critical queue
// helpers (enqueue idempotency, claimNext, defer, retry gating). These are
// pure SQL — unit-mockable only by reimplementing Postgres — so they were
// previously untested. The whole describe is SKIPPED (not failed) when no
// Postgres is reachable, so `bun test` stays green locally / in CI without
// a DB; run `docker compose up -d db` (or set DATABASE_URL) to exercise it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runMigrations, sql } from '../src/db.ts';
import {
  claimNext,
  deferReview,
  enqueueReview,
  getReview,
  markFailed,
  retryFailedReview,
  type EnqueueInput,
} from '../src/db/reviews.ts';

/** Resolve true only if a trivial query succeeds within a short budget, so a
 * missing DB costs ~2s once instead of the pool's 10s connect_timeout. */
async function dbReachable(): Promise<boolean> {
  const probe = sql`SELECT 1`.then(
    () => 'ok' as const,
    () => 'err' as const,
  );
  const timeout = new Promise<'timeout'>((res) =>
    setTimeout(() => res('timeout'), 2000),
  );
  return (await Promise.race([probe, timeout])) === 'ok';
}

const dbUp = await dbReachable();
const suite = dbUp ? describe : describe.skip;

if (!dbUp) {
  console.warn(
    '[queue-integration] no Postgres reachable — skipping. ' +
      '`docker compose up -d db` (or set DATABASE_URL) to run these.',
  );
}

suite('queue helpers (Postgres integration)', () => {
  // Sentinel keeps the test PR out of any real user's queue view, and the
  // user cascade-deletes everything we create on teardown.
  const REPO = `arbiter-itest/queue-${Date.now()}`;
  let userId: number;

  function input(over: Partial<EnqueueInput> = {}): EnqueueInput {
    return {
      userId,
      repoFull: REPO,
      prNumber: 1,
      prTitle: 'itest',
      prAuthor: 'octocat',
      baseBranch: 'main',
      headBranch: 'feature/x',
      headSha: 'sha-aaa',
      scrutiny: 'standard',
      claudeMode: 'subscription',
      autoApprove: false,
      gateOnBlocking: false,
      footerTemplate: null,
      personalityPrompt: null,
      reviewContext: 'isolated',
      ...over,
    };
  }

  beforeAll(async () => {
    await runMigrations();
    const [u] = await sql<{ id: number }[]>`
      INSERT INTO users (github_id, github_login, github_token)
      VALUES (${-Date.now()}, ${'itest-user'}, ${'itest-token'})
      RETURNING id
    `;
    userId = u!.id;
  });

  afterAll(async () => {
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql.end({ timeout: 5 });
  });

  test('enqueueReview is idempotent on (repo, pr#, head_sha)', async () => {
    const first = await enqueueReview(input());
    expect(first).not.toBeNull();
    expect(first!.status).toBe('queued');

    const dup = await enqueueReview(input());
    expect(dup).toBeNull(); // ON CONFLICT DO NOTHING

    const newSha = await enqueueReview(input({ headSha: 'sha-bbb' }));
    expect(newSha).not.toBeNull();
    expect(newSha!.id).not.toBe(first!.id);
  });

  test('claimNext claims oldest queued row and is exclusive', async () => {
    const a = await claimNext();
    expect(a).not.toBeNull();
    expect(a!.status).toBe('running');
    expect(a!.phase).toBe('preparing');
    expect(a!.startedAt).not.toBeNull();

    const b = await claimNext();
    expect(b).not.toBeNull(); // the second queued row (new head_sha)
    expect(b!.id).not.toBe(a!.id);

    const c = await claimNext();
    expect(c).toBeNull(); // nothing left queued
  });

  test('retryFailedReview only resurrects a failed row, scoped to the user', async () => {
    const row = await enqueueReview(input({ headSha: 'sha-retry' }));
    expect(row).not.toBeNull();
    const id = row!.id;

    // Not failed yet → retry is a no-op.
    expect(await retryFailedReview(userId, id)).toBeNull();

    await markFailed(id, 'boom');
    expect((await getReview(userId, id))!.status).toBe('failed');

    const retried = await retryFailedReview(userId, id);
    expect(retried).not.toBeNull();
    expect(retried!.status).toBe('queued');
    expect(retried!.error).toBeNull();

    // Wrong user can't retry someone else's row.
    await markFailed(id, 'boom again');
    expect(await retryFailedReview(userId + 99999, id)).toBeNull();
  });

  test('deferReview re-queues with a future defer_until that claimNext skips', async () => {
    const row = await enqueueReview(input({ headSha: 'sha-defer' }));
    const id = row!.id;

    // Claim it so it's the only running row, then defer it back.
    let claimed = await claimNext();
    while (claimed && claimed.id !== id) claimed = await claimNext();
    expect(claimed).not.toBeNull();

    const deferred = await deferReview(id, 3600);
    expect(deferred).not.toBeNull();
    expect(deferred!.status).toBe('queued');
    expect(deferred!.deferUntil).not.toBeNull();
    expect(deferred!.deferCount).toBe(1);

    // It's queued again but defer_until is in the future → not claimable.
    expect(await claimNext()).toBeNull();
  });
});
