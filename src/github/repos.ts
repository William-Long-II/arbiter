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

const PER_PAGE = 100;
const HARD_CAP = 1000;       // refuse to list more than this — protects API budget

export type ListReposOptions = {
  /** "all" | "owner" | "public" | "private" | "member" — passed to GitHub */
  affiliation?: 'owner' | 'collaborator' | 'organization_member';
  /** Sort by — default 'pushed' so most-active repos surface first */
  sort?: 'created' | 'updated' | 'pushed' | 'full_name';
};

export async function listAccessibleRepos(
  token: string,
  opts: ListReposOptions = {},
): Promise<Repo[]> {
  const octokit = octokitFor(token);
  const all: Repo[] = [];
  let page = 1;

  while (all.length < HARD_CAP) {
    const res = await octokit.rest.repos.listForAuthenticatedUser({
      per_page: PER_PAGE,
      page,
      sort: opts.sort ?? 'pushed',
      affiliation: opts.affiliation
        ? opts.affiliation
        : 'owner,collaborator,organization_member',
    });
    if (res.data.length === 0) break;
    for (const r of res.data) {
      all.push({
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        private: r.private,
        fork: r.fork,
        archived: r.archived,
        pushedAt: r.pushed_at,
        description: r.description ?? null,
        permissions: {
          push: r.permissions?.push ?? false,
          admin: r.permissions?.admin ?? false,
        },
      });
    }
    if (res.data.length < PER_PAGE) break;
    page += 1;
  }
  return all;
}

export function filterRepos(repos: Repo[], query: string): Repo[] {
  const q = query.trim().toLowerCase();
  if (!q) return repos;
  return repos.filter((r) => r.fullName.toLowerCase().includes(q));
}
