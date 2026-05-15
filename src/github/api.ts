// Octokit factory bound to a user's OAuth token. The projected PR shapes
// live with their consumers: PRDetails in github/pulls.ts is the canonical
// one.
import { Octokit } from '@octokit/rest';

// One Octokit per token, reused across calls. A poll tick fans out several
// GitHub calls (search, per-PR meta, checks) and the /repos page does
// 1 + N-orgs; previously each `octokitFor()` rebuilt the whole auth +
// request pipeline. Reusing the instance keeps the underlying fetch
// keep-alive pool warm and gives one place to later hang shared retry /
// throttle state. Bounded LRU so rotated/revoked tokens don't accumulate;
// keying by token means a re-auth naturally lands on a fresh client.
const MAX_CLIENTS = 256;
const clients = new Map<string, Octokit>();

export function octokitFor(token: string): Octokit {
  const cached = clients.get(token);
  if (cached) {
    // Touch for LRU recency (Map preserves insertion order).
    clients.delete(token);
    clients.set(token, cached);
    return cached;
  }
  if (clients.size >= MAX_CLIENTS) {
    const oldest = clients.keys().next().value;
    if (oldest !== undefined) clients.delete(oldest);
  }
  const client = new Octokit({ auth: token });
  clients.set(token, client);
  return client;
}

/** Test/diagnostic hook: number of live cached clients. */
export function octokitCacheSize(): number {
  return clients.size;
}
