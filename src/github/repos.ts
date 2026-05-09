import { octokitFor } from './api.ts';

export type Repo = {
  fullName: string;          // "owner/name"
  defaultBranch: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  pushedAt: string | null;   // ISO timestamp
  description: string | null;
  permissions: { push: boolean; admin: boolean };
};

export type RepoSource =
  | { kind: 'user'; status: 'ok' | 'error'; count: number; error?: string }
  | {
      kind: 'org';
      org: string;
      status: 'ok' | 'empty' | 'error';
      count: number;
      error?: string;
    };

export type ListAccessibleReposResult = {
  repos: Repo[];
  sources: RepoSource[];
};

type GhRepoLike = {
  full_name: string;
  default_branch?: string;
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  pushed_at?: string | null;
  description?: string | null;
  permissions?: { push?: boolean; admin?: boolean };
};

const PER_PAGE = 100;
const HARD_CAP = 1000;
const MAX_ORGS = 200;

type Octo = ReturnType<typeof octokitFor>;

/**
 * List every repository the authenticated user can see.
 *
 * GitHub's /user/repos only includes org repos when the OAuth app has been
 * approved at the user-endpoint level. Many orgs restrict third-party OAuth
 * apps and require an org-level approval. To surface those, we additionally
 * walk the user's org memberships and call /orgs/{org}/repos for each.
 *
 * Repos that appear from both sources are deduplicated by `full_name`.
 *
 * The `sources` array tells the UI which buckets contributed; an org with
 * `status: 'empty'` is the signal to suggest "approve the OAuth app at
 * github.com/orgs/{org}/policies/applications".
 */
export async function listAccessibleRepos(token: string): Promise<ListAccessibleReposResult> {
  const octokit = octokitFor(token);
  const collected = new Map<string, Repo>();

  // Fetch user-endpoint and orgs in parallel.
  const [userResult, orgsListResult] = await Promise.all([
    safe(() => listForAuthenticatedUser(octokit)),
    safe(() => listUserOrgs(octokit)),
  ]);

  // Fan out per-org in parallel. If listing orgs failed, this is just [].
  const orgs = orgsListResult.ok ? orgsListResult.value : [];
  const orgResults = await Promise.all(orgs.map((org) => listForOrgSafe(octokit, org)));

  // Attribution priority: orgs first. A repo accessible via an org gets
  // attributed to that org (not the user pill), even if /user/repos also
  // returned it (which happens when the user is an org owner — GitHub
  // surfaces the org's repos under affiliation=owner too).
  const orgSources: RepoSource[] = [];
  for (const r of orgResults) {
    let uniqueAdded = 0;
    for (const repo of r.repos) {
      if (!collected.has(repo.fullName)) {
        collected.set(repo.fullName, repo);
        uniqueAdded++;
      }
    }
    orgSources.push({
      kind: 'org',
      org: r.org,
      status: r.repos.length === 0 && r.status !== 'error' ? 'empty' : r.status,
      count: uniqueAdded,
      ...(r.error ? { error: r.error } : {}),
    });
  }

  // Now the user pill counts only repos that DIDN'T come from any org.
  let userSource: RepoSource;
  if (!userResult.ok) {
    userSource = {
      kind: 'user',
      status: 'error',
      count: 0,
      error: errorMessage(userResult.error),
    };
  } else {
    let userUnique = 0;
    for (const repo of userResult.value) {
      if (!collected.has(repo.fullName)) {
        collected.set(repo.fullName, repo);
        userUnique++;
      }
    }
    userSource = { kind: 'user', status: 'ok', count: userUnique };
  }

  return { repos: [...collected.values()], sources: [userSource, ...orgSources] };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: unknown };
async function safe<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function listForAuthenticatedUser(octokit: Octo): Promise<Repo[]> {
  const all: Repo[] = [];
  let page = 1;
  while (all.length < HARD_CAP) {
    const res = await octokit.rest.repos.listForAuthenticatedUser({
      per_page: PER_PAGE,
      page,
      sort: 'pushed',
      // Intentionally omit `organization_member` — those repos come through
      // the per-org fan-out (listForOrg) below and would double-count here.
      // "your account" should mean "personal repos + repos you're a direct
      // collaborator on," not "every repo your token can see."
      affiliation: 'owner,collaborator',
    });
    if (res.data.length === 0) break;
    for (const r of res.data) all.push(projectRepo(r));
    if (res.data.length < PER_PAGE) break;
    page += 1;
  }
  return all;
}

async function listUserOrgs(octokit: Octo): Promise<string[]> {
  const orgs: string[] = [];
  let page = 1;
  while (orgs.length < MAX_ORGS) {
    const res = await octokit.rest.orgs.listForAuthenticatedUser({
      per_page: PER_PAGE,
      page,
    });
    if (res.data.length === 0) break;
    for (const o of res.data) orgs.push(o.login);
    if (res.data.length < PER_PAGE) break;
    page += 1;
  }
  return orgs;
}

async function listForOrg(octokit: Octo, org: string): Promise<Repo[]> {
  const all: Repo[] = [];
  let page = 1;
  while (all.length < HARD_CAP) {
    const res = await octokit.rest.repos.listForOrg({
      org,
      per_page: PER_PAGE,
      page,
      sort: 'pushed',
      type: 'all',
    });
    if (res.data.length === 0) break;
    for (const r of res.data) all.push(projectRepo(r));
    if (res.data.length < PER_PAGE) break;
    page += 1;
  }
  return all;
}

async function listForOrgSafe(
  octokit: Octo,
  org: string,
): Promise<{ org: string; repos: Repo[]; status: 'ok' | 'empty' | 'error'; error?: string }> {
  try {
    const repos = await listForOrg(octokit, org);
    return { org, repos, status: repos.length === 0 ? 'empty' : 'ok' };
  } catch (err) {
    return { org, repos: [], status: 'error', error: errorMessage(err) };
  }
}

function projectRepo(r: GhRepoLike): Repo {
  return {
    fullName: r.full_name,
    defaultBranch: r.default_branch ?? 'main',
    private: r.private ?? false,
    fork: r.fork ?? false,
    archived: r.archived ?? false,
    pushedAt: r.pushed_at ?? null,
    description: r.description ?? null,
    permissions: {
      push: r.permissions?.push ?? false,
      admin: r.permissions?.admin ?? false,
    },
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function filterRepos(repos: Repo[], query: string): Repo[] {
  const q = query.trim().toLowerCase();
  if (!q) return repos;
  return repos.filter((r) => r.fullName.toLowerCase().includes(q));
}

export function excludeArchived(repos: Repo[]): Repo[] {
  return repos.filter((r) => !r.archived);
}

/**
 * Group repos by owner ("owner/name" → keyed by "owner"), preserving the
 * order each owner first appeared. The optional `firstOwner` is moved to the
 * front of the result regardless of where it first appeared (typically used
 * to surface the signed-in user's own login first).
 */
export function groupReposByOwner(
  repos: Repo[],
  firstOwner?: string,
): Array<{ owner: string; repos: Repo[] }> {
  const buckets = new Map<string, Repo[]>();
  for (const r of repos) {
    const owner = r.fullName.split('/')[0] ?? '';
    let bucket = buckets.get(owner);
    if (!bucket) {
      bucket = [];
      buckets.set(owner, bucket);
    }
    bucket.push(r);
  }
  const groups: Array<{ owner: string; repos: Repo[] }> = [];
  if (firstOwner && buckets.has(firstOwner)) {
    groups.push({ owner: firstOwner, repos: buckets.get(firstOwner)! });
    buckets.delete(firstOwner);
  }
  for (const [owner, items] of buckets) {
    groups.push({ owner, repos: items });
  }
  return groups;
}
