// The OAuth → App seam. Given a repo and the owning user's OAuth token,
// return the credential a GitHub call should use: a short-lived App
// installation token when the App is configured AND installed on that
// repo's account, otherwise the OAuth token unchanged.
//
// Slice 2: defined + fully tested, but NOT yet called by the worker/
// poller/checkout — slice 3 flips those call sites to route through here.
// Designed so the OAuth path is the safe default at every branch: not
// configured, no installation, lookup error, or mint error all fall back
// to the OAuth token. App auth never makes reviews *more* fragile.

import { getInstallationToken, githubAppConfigured } from './app.ts';
import { lookupInstallationByOwner } from '../db/installations.ts';

export type TokenSource = 'oauth' | 'app-installation';
export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

/** All injectable for tests; defaults wire the real config/DB/minter. */
export interface ResolveDeps {
  configured?: () => boolean;
  lookup?: (owner: string) => Promise<{ installationId: number } | null>;
  mint?: (installationId: number) => Promise<{ token: string }>;
}

export async function resolveRepoToken(
  repoFull: string,
  fallbackOAuthToken: string,
  deps: ResolveDeps = {},
): Promise<ResolvedToken> {
  const oauth: ResolvedToken = { token: fallbackOAuthToken, source: 'oauth' };

  const configured = deps.configured ?? githubAppConfigured;
  if (!configured()) return oauth;

  const owner = repoFull.split('/')[0] ?? '';
  if (!owner) return oauth;

  const lookup = deps.lookup ?? lookupInstallationByOwner;
  let inst: { installationId: number } | null;
  try {
    inst = await lookup(owner);
  } catch (err) {
    console.error(
      `[token] installation lookup failed for ${owner}; using OAuth:`,
      err,
    );
    return oauth;
  }
  if (!inst) return oauth;

  const mint = deps.mint ?? getInstallationToken;
  try {
    const t = await mint(inst.installationId);
    return { token: t.token, source: 'app-installation' };
  } catch (err) {
    // A flaky access_tokens call must never fail a review while OAuth
    // still works — degrade rather than throw.
    console.error(
      `[token] installation-token mint failed for ${owner} ` +
        `(installation ${inst.installationId}); using OAuth:`,
      err,
    );
    return oauth;
  }
}
