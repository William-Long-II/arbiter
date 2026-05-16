// GitHub webhook receiver helpers — signature verification and payload
// parsing. Kept pure (no DB, no network) so they unit-test directly; the
// route in web/server.tsx does the I/O and the enqueue dispatch.

import type { PRDetails } from './pulls.ts';

// Pull-request actions worth a (re)review. Deliberately excludes `edited`,
// `labeled`, `closed`, `assigned`, etc. `review_requested` is intentionally
// NOT here: resolving team-based review requests needs the GraphQL search
// the poller already does, so review_requested-mode scopes keep relying on
// the poller. `ready_for_review` covers the draft→ready transition.
const RELEVANT_ACTIONS = new Set([
  'opened',
  'reopened',
  'synchronize',
  'ready_for_review',
]);

const encoder = new TextEncoder();

/**
 * Verify GitHub's `X-Hub-Signature-256` over the RAW request body.
 * Header form is `sha256=<hex>`. Returns false for any missing/!malformed
 * input rather than throwing, and compares in constant time so a timing
 * side-channel can't probe the digest.
 */
export async function verifyGithubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | null | undefined,
): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) return false;
  const provided = signatureHeader.slice(expectedPrefix.length);

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const computed = [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeEqual(computed, provided.toLowerCase());
}

/** Length-independent constant-time string compare (hex digests). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type GhPullRequestPayload = {
  action?: unknown;
  number?: unknown;
  repository?: { full_name?: unknown };
  pull_request?: {
    title?: unknown;
    user?: { login?: unknown };
    base?: { ref?: unknown };
    head?: { ref?: unknown; sha?: unknown };
    draft?: unknown;
    auto_merge?: unknown;
  };
};

export type ParsedPullRequestEvent = { action: string; pr: PRDetails };

/**
 * Normalize a `pull_request` webhook into the same PRDetails the poller
 * produces, or null when this delivery should be ignored: wrong event,
 * uninteresting action, a draft PR, or a payload missing fields we need.
 * Draft PRs are skipped (the `ready_for_review` action carries draft:false
 * and is what triggers their first review) — mirrors the poller, which
 * filters drafts out of its search results.
 */
export function parsePullRequestEvent(
  eventName: string | null | undefined,
  payload: unknown,
): ParsedPullRequestEvent | null {
  if (eventName !== 'pull_request') return null;
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as GhPullRequestPayload;

  const action = typeof p.action === 'string' ? p.action : '';
  if (!RELEVANT_ACTIONS.has(action)) return null;

  const number = typeof p.number === 'number' ? p.number : NaN;
  const repoFull =
    typeof p.repository?.full_name === 'string' ? p.repository.full_name : '';
  const pull = p.pull_request;
  if (!pull || !repoFull || !Number.isInteger(number) || number <= 0) {
    return null;
  }

  const draft = pull.draft === true;
  if (draft) return null; // never review a draft

  const title = typeof pull.title === 'string' ? pull.title : '';
  const author =
    typeof pull.user?.login === 'string' ? pull.user.login : 'unknown';
  const baseBranch = typeof pull.base?.ref === 'string' ? pull.base.ref : '';
  const headBranch = typeof pull.head?.ref === 'string' ? pull.head.ref : '';
  const headSha = typeof pull.head?.sha === 'string' ? pull.head.sha : '';
  if (!baseBranch || !headSha) return null;

  return {
    action,
    pr: {
      repoFull,
      number,
      title,
      author,
      baseBranch,
      headBranch,
      headSha,
      draft: false,
      autoMerge: pull.auto_merge != null,
    },
  };
}

type GhInstallationPayload = {
  action?: unknown;
  installation?: {
    id?: unknown;
    account?: { login?: unknown; type?: unknown };
  };
};

/** Normalized App-installation lifecycle change for db/installations. */
export type ParsedInstallationEvent = {
  /** upsert: created / re-permissioned. remove: uninstalled.
   *  suspend|unsuspend: paused/resumed (row stays, resolver skips it). */
  kind: 'upsert' | 'remove' | 'suspend' | 'unsuspend';
  installationId: number;
  /** Always present from GitHub; '' only if a malformed `remove` omitted
   *  it (remove keys off installationId anyway). */
  accountLogin: string;
  accountType: string | null;
};

// `installation_repositories` (repos added/removed within an install) is
// intentionally NOT handled here: slice 2 maps per *account*, and the
// `installation` event already covers the create/delete the resolver
// needs. The route acknowledges those deliveries as ignored.
const INSTALLATION_ACTION_KIND: Record<string, ParsedInstallationEvent['kind']> = {
  created: 'upsert',
  new_permissions_accepted: 'upsert',
  deleted: 'remove',
  suspend: 'suspend',
  unsuspend: 'unsuspend',
};

/**
 * Normalize an `installation` webhook, or null when it should be ignored
 * (wrong event, uninteresting action, or missing the id we key on).
 * Pure — the route does the DB write.
 */
export function parseInstallationEvent(
  eventName: string | null | undefined,
  payload: unknown,
): ParsedInstallationEvent | null {
  if (eventName !== 'installation') return null;
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as GhInstallationPayload;

  const action = typeof p.action === 'string' ? p.action : '';
  const kind = INSTALLATION_ACTION_KIND[action];
  if (!kind) return null;

  const inst = p.installation;
  const installationId =
    typeof inst?.id === 'number' ? inst.id : NaN;
  if (!Number.isInteger(installationId) || installationId <= 0) return null;

  const accountLogin =
    typeof inst?.account?.login === 'string' ? inst.account.login : '';
  const accountType =
    typeof inst?.account?.type === 'string' ? inst.account.type : null;

  // upsert needs a login to key the row; remove/suspend/unsuspend key off
  // installationId so a login-less payload is still actionable.
  if (kind === 'upsert' && !accountLogin) return null;

  return { kind, installationId, accountLogin, accountType };
}
