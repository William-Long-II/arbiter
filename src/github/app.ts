// GitHub App credential core — slice 1 of the OAuth → GitHub App
// migration (roadmap #19/#20, the keystone).
//
// Why this exists: today every GitHub call uses a broad-scoped OAuth
// *user* token persisted unencrypted in `users.github_token` (the audit's
// top finding). A GitHub App instead mints **installation** access
// tokens: short-lived (~1h), scoped to the App's declared permissions on
// that installation's repos, and minted on demand from the App's private
// key — so nothing broad or long-lived is stored at rest.
//
// This module is purely additive and inert until `GITHUB_APP_ID` +
// `GITHUB_APP_PRIVATE_KEY` are set: no call site uses it yet. Slice 2
// adds the installation⇄owner mapping (App webhook events) + a token
// resolver; slice 3 flips the worker/poller/checkout to prefer it. The
// RS256 JWT + access-token exchange is delegated to the vetted
// `@octokit/auth-app` (don't hand-roll credential crypto); the caching,
// refresh-margin, and concurrency control here are ours and tested.

import { createAppAuth } from '@octokit/auth-app';
import { config } from '../config.ts';

export interface InstallationToken {
  token: string;
  /** Absolute expiry as reported by GitHub (~1h out). */
  expiresAt: Date;
}

/** Mints a fresh installation token. Injected in tests so the cache /
 *  dedupe / expiry logic is exercised without network or real keys. */
export type InstallationMinter = (installationId: number) => Promise<InstallationToken>;

/**
 * Normalize an App private key from the environment. Two real footguns:
 *  - PEM has newlines; `.env` files mangle them, so operators commonly
 *    paste it with literal backslash-n — convert those back.
 *  - Some setups base64 the whole PEM to dodge the newline issue entirely
 *    — detect (no PEM header, base64-ish) and decode.
 * Pure; safe on empty input. Exported for direct unit testing.
 */
export function normalizeAppPrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const deEscaped = trimmed.includes('\\n')
    ? trimmed.replace(/\\n/g, '\n')
    : trimmed;
  if (deEscaped.includes('-----BEGIN')) return deEscaped;
  // No PEM header — assume base64-wrapped PEM if it decodes to one.
  if (/^[A-Za-z0-9+/=\s]+$/.test(deEscaped)) {
    try {
      const decoded = Buffer.from(deEscaped, 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN')) return decoded;
    } catch {
      /* fall through — return as-is, the minter will surface a clear error */
    }
  }
  return deEscaped;
}

/** True only when both App credentials are present and the key is usable. */
export function githubAppConfigured(): boolean {
  return Boolean(
    config.github.app.appId && normalizeAppPrivateKey(config.github.app.privateKey),
  );
}

// Refresh this far before the real expiry so an in-progress review never
// posts with a token that dies mid-call.
const REFRESH_MARGIN_MS = 5 * 60_000;

const cache = new Map<number, InstallationToken>();
// Per-installation in-flight mint. The multi-worker pool can ask for the
// same installation's token from several slots at once; without this they
// would stampede GitHub's access_tokens endpoint. Concurrent callers
// share one mint and one result.
const inflight = new Map<number, Promise<InstallationToken>>();

/** Test hook: drop all cached/in-flight token state. */
export function resetInstallationTokenCache(): void {
  cache.clear();
  inflight.clear();
}

const defaultMint: InstallationMinter = async (installationId) => {
  if (!githubAppConfigured()) {
    throw new Error(
      'GitHub App not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)',
    );
  }
  const auth = createAppAuth({
    appId: config.github.app.appId,
    privateKey: normalizeAppPrivateKey(config.github.app.privateKey),
  });
  const r = await auth({ type: 'installation', installationId });
  return { token: r.token, expiresAt: new Date(r.expiresAt) };
};

/**
 * A valid installation token, reused until it nears expiry. Concurrent
 * callers for the same installation share a single mint. `deps` is for
 * tests only (inject a clock and a fake minter).
 */
export async function getInstallationToken(
  installationId: number,
  deps: { now?: () => number; mint?: InstallationMinter } = {},
): Promise<InstallationToken> {
  const now = deps.now ?? Date.now;
  const mint = deps.mint ?? defaultMint;

  const cached = cache.get(installationId);
  if (cached && cached.expiresAt.getTime() - now() > REFRESH_MARGIN_MS) {
    return cached;
  }

  const pending = inflight.get(installationId);
  if (pending) return pending;

  const p = (async () => {
    try {
      const minted = await mint(installationId);
      cache.set(installationId, minted);
      return minted;
    } finally {
      inflight.delete(installationId);
    }
  })();
  inflight.set(installationId, p);
  return p;
}
