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
  const sources: RepoSource[] = [];
  const collected = new Map<string, Repo>();

  try {
    const userRepos = await listForAuthenticatedUser(octokit);
    sources.push({ kind: 'user', status: 'ok', count: userRepos.length });
    for (const r of userRepos) collected.set(r.fullName, r);
  } catch (err) {
    sources.push({ kind: 'user', status: 'error', count: 0, error: errorMessage(err) });
  }

  let orgs: string[] = [];
  try {
    orgs = await listUserOrgs(octokit);
  } catch {
    // Some tokens can't list orgs; we still have whatever /user/repos returned.
  }

  const orgResults = await Promise.all(
    orgs.map((org) => listForOrgSafe(octokit, org)),
  );

  for (const r of orgResults) {
    sources.push({
      kind: 'org',
      org: r.org,
      status: r.status,
      count: r.repos.length,
      ...(r.error ? { error: r.error } : {}),
    });
    for (const repo of r.repos) {
      if (!collected.has(repo.fullName)) collected.set(repo.fullName, repo);
    }
  }

  return { repos: [...collected.values()], sources };
}

async function listForAuthenticatedUser(octokit: Octo): Promise<Repo[]> {
  const all: Repo[] = [];
  let page = 1;
  while (all.length < HARD_CAP) {
    const res = await octokit.rest.repos.listForAuthenticatedUser({
      per_page: PER_PAGE,
      page,
      sort: 'pushed',
      affiliation: 'owner,collaborator,organization_member',
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
