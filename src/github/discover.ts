import type { Config } from "../config.ts";
import type { GH } from "./client.ts";

export type RepoRef = { owner: string; name: string };

function slug(r: RepoRef): string {
  return `${r.owner}/${r.name}`;
}

export async function resolveWatchedRepos(gh: GH, cfg: Config): Promise<RepoRef[]> {
  const seen = new Set<string>();
  const out: RepoRef[] = [];
  const add = (r: RepoRef) => {
    const key = slug(r).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(r);
  };

  for (const org of cfg.watch.orgs) {
    const repos = await listOrgRepos(gh, org.name);
    const names = repos.map((r) => r.name);
    const filtered = applyOrgFilter(names, org);
    for (const name of filtered) add({ owner: org.name, name });
  }

  for (const r of cfg.watch.repos) {
    const [owner, name] = r.slug.split("/");
    if (!owner || !name) continue;
    add({ owner, name });
  }

  return out;
}

function applyOrgFilter(
  names: string[],
  org: Config["watch"]["orgs"][number],
): string[] {
  if (org.mode === "include") {
    const wanted = new Set((org.include ?? []).map((n) => n.toLowerCase()));
    return names.filter((n) => wanted.has(n.toLowerCase()));
  }
  const excluded = new Set((org.exclude ?? []).map((n) => n.toLowerCase()));
  return names.filter((n) => !excluded.has(n.toLowerCase()));
}

async function listOrgRepos(gh: GH, org: string): Promise<{ name: string }[]> {
  const all: { name: string }[] = [];
  let page = 1;
  while (true) {
    const res = await gh.repos.listForOrg({
      org,
      type: "all",
      per_page: 100,
      page,
    });
    all.push(...res.data.map((r) => ({ name: r.name })));
    if (res.data.length < 100) break;
    page += 1;
  }
  return all;
}

export type PullRef = {
  repo: RepoRef;
  number: number;
  head_sha: string;
  author: string;
  /** True when GitHub marks the PR author as a bot account (dependabot, renovate, github-actions, custom bots). */
  author_is_bot: boolean;
  draft: boolean;
  title: string;
};

export async function listOpenPulls(gh: GH, repo: RepoRef): Promise<PullRef[]> {
  const out: PullRef[] = [];
  let page = 1;
  while (true) {
    const res = await gh.pulls.list({
      owner: repo.owner,
      repo: repo.name,
      state: "open",
      per_page: 100,
      page,
    });
    for (const pr of res.data) {
      out.push({
        repo,
        number: pr.number,
        head_sha: pr.head.sha,
        author: pr.user?.login ?? "",
        author_is_bot: pr.user?.type === "Bot",
        draft: pr.draft ?? false,
        title: pr.title,
      });
    }
    if (res.data.length < 100) break;
    page += 1;
  }
  return out;
}

export function filterReviewable(prs: PullRef[], cfg: Config): PullRef[] {
  const skip = new Set(cfg.github.skip_authors.map((a) => a.toLowerCase()));
  skip.add(cfg.github.bot_username.toLowerCase());
  return prs.filter((p) => {
    if (cfg.review.skip_drafts && p.draft) return false;
    if (cfg.review.skip_bots && p.author_is_bot) return false;
    if (skip.has(p.author.toLowerCase())) return false;
    return true;
  });
}
