/**
 * Instance settings: env-pinned or wizard-written.
 *
 * A fresh instance can boot with nothing but SESSION_SECRET, DATABASE_URL,
 * and PUBLIC_URL in the environment; the first-run setup wizard (web/setup.ts)
 * collects GitHub OAuth credentials, a Claude subscription token, and an
 * optional webhook secret, and stores them here. Operators who prefer env
 * config are unaffected: for every key, a non-empty env var wins over the
 * DB row, and when the env fully configures the instance the wizard never
 * appears.
 *
 * The cache is process-local and loaded once at boot (loadAppSettings).
 * That's sound because each arbiter deployment is a single process and the
 * only writer is the wizard in this same process, which updates the cache
 * on write.
 */

import { sql } from './db.ts';
import { config } from './config.ts';

export const SETTING_KEYS = [
  'github_client_id',
  'github_client_secret',
  'github_webhook_secret',
  'claude_code_oauth_token',
  'allowed_github_logins',
  'setup_completed_at',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

let cache: Map<string, string> | null = null;

/** Load all rows into the process-local cache. Call once at boot, after
 *  migrations. Safe to call again (wizard re-entry, tests). */
export async function loadAppSettings(): Promise<void> {
  const rows = await sql<{ key: string; value: string }[]>`
    SELECT key, value FROM app_settings
  `;
  cache = new Map(rows.map((r) => [r.key, r.value]));
}

function cached(key: SettingKey): string {
  // Boot loads the cache before the server accepts requests. If a caller
  // somehow reads earlier (unit tests building the app without booting),
  // degrade to env-only resolution — the pre-wizard semantics — rather
  // than crashing the request.
  return cache?.get(key) ?? '';
}

/** Persist settings and update the cache. Empty values are skipped, not
 *  written — the wizard treats blank optional fields as "leave unset". */
export async function saveAppSettings(
  entries: Partial<Record<SettingKey, string>>,
): Promise<void> {
  if (!cache) cache = new Map();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === '') continue;
    await sql`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (${key}, ${value}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
    cache.set(key, value);
  }
}

/** Env wins; DB fills blanks. Pure — exported for tests. */
export function resolveEffective(envValue: string, dbValue: string): string {
  return envValue !== '' ? envValue : dbValue;
}

export function effectiveGithubClientId(): string {
  return resolveEffective(config.github.clientId, cached('github_client_id'));
}

export function effectiveGithubClientSecret(): string {
  return resolveEffective(config.github.clientSecret, cached('github_client_secret'));
}

export function effectiveWebhookSecret(): string {
  return resolveEffective(config.github.webhookSecret, cached('github_webhook_secret'));
}

export function effectiveClaudeOauthToken(): string {
  return resolveEffective(
    process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '',
    cached('claude_code_oauth_token'),
  );
}

/** Parse an allowlist string (comma/whitespace-separated GitHub logins,
 *  optional leading @) into a lowercased set. Pure — exported for tests. */
export function parseAllowedLogins(raw: string): Set<string> {
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((s) => s.replace(/^@/, '').trim().toLowerCase())
      .filter(Boolean),
  );
}

export function effectiveAllowedLogins(): Set<string> {
  return parseAllowedLogins(
    resolveEffective(
      process.env.ALLOWED_GITHUB_LOGINS ?? '',
      cached('allowed_github_logins'),
    ),
  );
}

/**
 * Sign-in policy for the OAuth callback. Reviews run on the instance's
 * Claude credentials, so an open sign-in would let any GitHub account
 * spend the owner's subscription. Allowed:
 *  - returning users (already in the users table — revoke by deleting
 *    the row and leaving them off the allowlist),
 *  - logins on the allowlist (env ALLOWED_GITHUB_LOGINS or the
 *    wizard-written setting),
 *  - anyone, when the users table is empty — the first sign-in claims
 *    the instance (the fresh-deploy bootstrap; mirrors the setup wizard,
 *    which is similarly first-come via the logged code).
 * Pure — exported for tests.
 */
export function isSignInAllowed(args: {
  login: string;
  isExistingUser: boolean;
  userCount: number;
  allowlist: Set<string>;
}): boolean {
  if (args.isExistingUser) return true;
  if (args.allowlist.has(args.login.toLowerCase())) return true;
  return args.userCount === 0;
}

/**
 * Does this instance still need the first-run wizard?
 *
 * Env-configured instances (both OAuth creds present in the environment)
 * never see it — that's every deployment that predates the wizard, where
 * Claude credentials arrive via bind-mount/token/API key and the boot
 * preflight still validates them exactly as before. Otherwise the wizard
 * is needed until it has been completed once.
 */
export function setupNeeded(): boolean {
  if (config.github.clientId && config.github.clientSecret) return false;
  return cached('setup_completed_at') === '';
}

/** Mark the wizard done. Split from saveAppSettings so a validation
 *  failure mid-save can't half-complete setup. */
export async function markSetupComplete(): Promise<void> {
  await saveAppSettings({ setup_completed_at: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// One-time setup code
//
// The wizard is reachable pre-auth (there is no OAuth to sign in with yet),
// so it is gated by a code generated at boot and printed to the container
// logs — proof of operator access, same pattern as Jellyfin/Grafana first-run.

let setupCode: string | null = null;

export function getSetupCode(): string {
  if (!setupCode) setupCode = crypto.randomUUID();
  return setupCode;
}

export function verifySetupCode(candidate: string): boolean {
  const expected = getSetupCode();
  if (candidate.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
  }
  return diff === 0;
}

export function formatSetupBanner(): string {
  return [
    '',
    '  ┌─ FIRST-RUN SETUP ─────────────────────────────────────────────────',
    '  │',
    '  │  This instance is not configured yet. Open the web UI:',
    '  │',
    `  │      ${config.publicUrl}/setup`,
    '  │',
    '  │  and enter this one-time setup code:',
    '  │',
    `  │      ${getSetupCode()}`,
    '  │',
    '  │  The wizard collects the GitHub OAuth app credentials, a Claude',
    '  │  subscription token (`claude setup-token`), and an optional',
    '  │  webhook secret. The code changes on every restart.',
    '  └───────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');
}
