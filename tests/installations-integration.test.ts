// Postgres-backed coverage for the App installation registry (pure SQL —
// only mockable by reimplementing Postgres). SKIPPED (not failed) when no
// DB is reachable, matching queue-integration; `docker compose up -d db`
// (or set DATABASE_URL) to exercise it.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { runMigrations, sql } from '../src/db.ts';
import {
  lookupInstallationByOwner,
  removeInstallation,
  setInstallationSuspended,
  upsertInstallation,
} from '../src/db/installations.ts';

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
    '[installations-integration] no Postgres reachable — skipping. ' +
      '`docker compose up -d db` (or set DATABASE_URL) to run these.',
  );
}

suite('app_installations registry', () => {
  beforeEach(async () => {
    await runMigrations();
    await sql`DELETE FROM app_installations`;
  });
  afterAll(async () => {
    await sql`DELETE FROM app_installations`;
  });

  test('upsert then lookup by owner (case-insensitive)', async () => {
    await upsertInstallation({
      accountLogin: 'Acme',
      installationId: 100,
      accountType: 'Organization',
    });
    const found = await lookupInstallationByOwner('acme');
    expect(found?.installationId).toBe(100);
    expect(found?.accountType).toBe('Organization');
    expect(found?.suspendedAt).toBeNull();
  });

  test('upsert is idempotent and refreshes installation_id / clears suspend', async () => {
    await upsertInstallation({ accountLogin: 'acme', installationId: 1, accountType: 'User' });
    await setInstallationSuspended(1, true);
    expect(await lookupInstallationByOwner('acme')).toBeNull(); // suspended hidden

    await upsertInstallation({ accountLogin: 'acme', installationId: 2, accountType: 'User' });
    const f = await lookupInstallationByOwner('acme');
    expect(f?.installationId).toBe(2); // refreshed
    expect(f?.suspendedAt).toBeNull(); // re-created clears suspension
  });

  test('an installation_id moving to a new login does not duplicate', async () => {
    await upsertInstallation({ accountLogin: 'old-name', installationId: 77, accountType: 'User' });
    await upsertInstallation({ accountLogin: 'new-name', installationId: 77, accountType: 'User' });
    expect(await lookupInstallationByOwner('old-name')).toBeNull();
    expect((await lookupInstallationByOwner('new-name'))?.installationId).toBe(77);
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app_installations WHERE installation_id = 77
    `;
    expect(n).toBe(1);
  });

  test('suspend hides, unsuspend restores, remove deletes', async () => {
    await upsertInstallation({ accountLogin: 'acme', installationId: 9, accountType: 'User' });
    await setInstallationSuspended(9, true);
    expect(await lookupInstallationByOwner('acme')).toBeNull();
    await setInstallationSuspended(9, false);
    expect((await lookupInstallationByOwner('acme'))?.installationId).toBe(9);
    await removeInstallation(9);
    expect(await lookupInstallationByOwner('acme')).toBeNull();
  });

  test('remove and suspend are idempotent on an unknown installation', async () => {
    await removeInstallation(123456);
    await setInstallationSuspended(123456, true); // no row — no throw
    expect(await lookupInstallationByOwner('nobody')).toBeNull();
  });
});
