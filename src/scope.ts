// Scope matching — stub. Given a PR and a user's scope rules, return the
// matching rule (and therefore scrutiny tier + claude mode), or null.
import type { PRMeta } from './github/api.ts';

export type Scope = {
  id: number;
  userId: number;
  targetKind: 'repo' | 'org';
  target: string;
  baseBranchPattern: string;
  scrutiny: 'light' | 'standard' | 'strict';
  excludeAuthors: string[];
  claudeMode: 'default' | 'subscription' | 'api';
  enabled: boolean;
};

export function matchScope(pr: PRMeta, scopes: Scope[], selfLogin: string): Scope | null {
  for (const s of scopes) {
    if (!s.enabled) continue;
    if (pr.author === selfLogin) continue;
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
