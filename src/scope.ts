// Scope matching: given a PR and a user's scope rules, return the matching
// rule (and therefore scrutiny tier + claude mode + auto-approve setting),
// or null. Used by both the poller (to decide which PRs to enqueue) and
// any future per-PR ad-hoc match path.

import type { PRDetails } from './github/pulls.ts';
import type { Scope } from './db/scopes.ts';

export function matchScope(
  pr: PRDetails,
  scopes: Scope[],
  selfLogin: string,
): Scope | null {
  for (const s of scopes) {
    if (!s.enabled) continue;
    if (pr.author.toLowerCase() === selfLogin.toLowerCase()) continue;
    if (s.excludeAuthors.includes(pr.author)) continue;

    if (s.targetKind === 'repo' && s.target !== pr.repoFull) continue;
    if (s.targetKind === 'org' && !pr.repoFull.startsWith(`${s.target}/`)) continue;

    if (!matchBranch(s.baseBranchPattern, pr.baseBranch)) continue;
    return s;
  }
  return null;
}

function matchBranch(pattern: string, branch: string): boolean {
  if (pattern === '*' || pattern === '') return true;
  if (pattern === branch) return true;
  // Simple glob: prefix-match with trailing *
  if (pattern.endsWith('*') && branch.startsWith(pattern.slice(0, -1))) return true;
  return false;
}
