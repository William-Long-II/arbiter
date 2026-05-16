// GitHub App installation registry — the owner→installation mapping the
// token resolver consults. Written only by the App webhook handler; read
// by resolveRepoToken. Slice 2: nothing in the review path calls the
// resolver yet, so this is inert until slice 3 + an actual App install.

import { sql } from '../db.ts';

export type AppInstallation = {
  accountLogin: string;
  installationId: number;
  accountType: string | null;
  suspendedAt: Date | null;
};

const COLS = sql`
  account_login   AS "accountLogin",
  installation_id AS "installationId",
  account_type    AS "accountType",
  suspended_at    AS "suspendedAt"
`;

/**
 * Record (or refresh) an installation. Keyed by account login; if GitHub
 * reuses an installation_id under a renamed/!recreated account the unique
 * index would reject the stale login, so we also clear any prior row that
 * holds this installation_id under a different login first. Clears
 * `suspended_at` (a `created`/`unsuspend` event means it's usable again).
 */
export async function upsertInstallation(input: {
  accountLogin: string;
  installationId: number;
  accountType: string | null;
}): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM app_installations
      WHERE installation_id = ${input.installationId}
        AND account_login <> ${input.accountLogin}
    `;
    await tx`
      INSERT INTO app_installations
        (account_login, installation_id, account_type, suspended_at, updated_at)
      VALUES
        (${input.accountLogin}, ${input.installationId}, ${input.accountType}, NULL, now())
      ON CONFLICT (account_login) DO UPDATE
      SET installation_id = EXCLUDED.installation_id,
          account_type    = EXCLUDED.account_type,
          suspended_at    = NULL,
          updated_at      = now()
    `;
  });
}

/** Remove an installation (App uninstalled). Idempotent. */
export async function removeInstallation(installationId: number): Promise<void> {
  await sql`DELETE FROM app_installations WHERE installation_id = ${installationId}`;
}

/**
 * Flip the suspended flag. Suspended installs stay in the table (the App
 * is still installed, just paused) but the resolver treats them as absent.
 */
export async function setInstallationSuspended(
  installationId: number,
  suspended: boolean,
): Promise<void> {
  await sql`
    UPDATE app_installations
    SET suspended_at = ${suspended ? sql`now()` : sql`NULL`},
        updated_at   = now()
    WHERE installation_id = ${installationId}
  `;
}

/**
 * The usable installation for an owner login, or null. A suspended install
 * resolves to null so the caller falls back to OAuth. Case-insensitive on
 * the login (GitHub treats account logins case-insensitively).
 */
export async function lookupInstallationByOwner(
  owner: string,
): Promise<AppInstallation | null> {
  const [row] = await sql<AppInstallation[]>`
    SELECT ${COLS}
    FROM app_installations
    WHERE lower(account_login) = lower(${owner})
      AND suspended_at IS NULL
    LIMIT 1
  `;
  return row ?? null;
}
