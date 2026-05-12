import { describe, expect, test } from 'bun:test';
import { matchScope } from '../src/scope.ts';
import type { Scope } from '../src/db/scopes.ts';
import type { PRDetails } from '../src/github/pulls.ts';

function scope(over: Partial<Scope> = {}): Scope {
  return {
    id: 1,
    userId: 1,
    targetKind: 'repo',
    target: 'acme/widget',
    baseBranchPattern: 'main',
    scrutiny: 'standard',
    excludeAuthors: ['dependabot[bot]'],
    claudeMode: 'default',
    autoApprove: false,
    footerTemplate: null,
    personalityPrompt: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function pr(over: Partial<PRDetails> = {}): PRDetails {
  return {
    repoFull: 'acme/widget',
    number: 1,
    title: 'Test',
    author: 'octocat',
    baseBranch: 'main',
    headBranch: 'feature/x',
    headSha: 'abc123',
    draft: false,
    autoMerge: false,
    ...over,
  };
}

describe('matchScope — basic', () => {
  test('matches on exact repo + branch', () => {
    expect(matchScope(pr(), [scope()], 'me')).not.toBeNull();
  });

  test('returns null when no rule applies', () => {
    expect(matchScope(pr({ repoFull: 'other/repo' }), [scope()], 'me')).toBeNull();
  });

  test('first matching rule wins', () => {
    const a = scope({ id: 1, scrutiny: 'light' });
    const b = scope({ id: 2, scrutiny: 'strict' });
    const m = matchScope(pr(), [a, b], 'me');
    expect(m?.id).toBe(1);
  });

  test('disabled scopes are skipped', () => {
    const disabled = scope({ id: 1, enabled: false });
    const enabled = scope({ id: 2 });
    const m = matchScope(pr(), [disabled, enabled], 'me');
    expect(m?.id).toBe(2);
  });
});

describe('matchScope — self/author filters', () => {
  test('skips PRs authored by the signed-in user', () => {
    expect(matchScope(pr({ author: 'me' }), [scope()], 'me')).toBeNull();
  });

  test('self check is case-insensitive', () => {
    expect(matchScope(pr({ author: 'Me' }), [scope()], 'me')).toBeNull();
  });

  test('skips PRs by excluded authors', () => {
    const s = scope({ excludeAuthors: ['dependabot[bot]', 'renovate[bot]'] });
    expect(matchScope(pr({ author: 'dependabot[bot]' }), [s], 'me')).toBeNull();
    expect(matchScope(pr({ author: 'renovate[bot]' }), [s], 'me')).toBeNull();
    expect(matchScope(pr({ author: 'octocat' }), [s], 'me')).not.toBeNull();
  });
});

describe('matchScope — target kind', () => {
  test('org target matches any repo in the org', () => {
    const s = scope({ targetKind: 'org', target: 'acme' });
    expect(matchScope(pr({ repoFull: 'acme/foo' }), [s], 'me')).not.toBeNull();
    expect(matchScope(pr({ repoFull: 'acme/bar' }), [s], 'me')).not.toBeNull();
  });

  test('org target does not match a substring-prefix repo', () => {
    // 'acme' should not match 'acme-corp/foo' (that's a different org).
    const s = scope({ targetKind: 'org', target: 'acme' });
    expect(matchScope(pr({ repoFull: 'acme-corp/foo' }), [s], 'me')).toBeNull();
  });
});

describe('matchScope — branch pattern', () => {
  test('exact match', () => {
    const s = scope({ baseBranchPattern: 'main' });
    expect(matchScope(pr({ baseBranch: 'main' }), [s], 'me')).not.toBeNull();
    expect(matchScope(pr({ baseBranch: 'develop' }), [s], 'me')).toBeNull();
  });

  test('"*" wildcard matches any branch', () => {
    const s = scope({ baseBranchPattern: '*' });
    expect(matchScope(pr({ baseBranch: 'main' }), [s], 'me')).not.toBeNull();
    expect(matchScope(pr({ baseBranch: 'release/v2' }), [s], 'me')).not.toBeNull();
  });

  test('trailing-* glob matches prefix', () => {
    const s = scope({ baseBranchPattern: 'release/*' });
    expect(matchScope(pr({ baseBranch: 'release/v1' }), [s], 'me')).not.toBeNull();
    expect(matchScope(pr({ baseBranch: 'release/v2.1' }), [s], 'me')).not.toBeNull();
    expect(matchScope(pr({ baseBranch: 'main' }), [s], 'me')).toBeNull();
  });
});
