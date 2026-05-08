import { describe, expect, test, mock, beforeEach } from 'bun:test';
import * as api from '../src/github/api.ts';
import { filterRepos, listAccessibleRepos, type Repo } from '../src/github/repos.ts';

type MockResponse = { data: Array<Record<string, unknown>> };

function makeOctokit(pages: Array<Array<Record<string, unknown>>>) {
  let call = 0;
  return {
    rest: {
      repos: {
        listForAuthenticatedUser: mock(async () => {
          const data = pages[call] ?? [];
          call++;
          return { data } as MockResponse;
        }),
      },
    },
  };
}

function ghRepo(over: Partial<Record<string, unknown>> = {}) {
  return {
    full_name: 'owner/name',
    default_branch: 'main',
    private: false,
    fork: false,
    archived: false,
    pushed_at: '2026-05-01T00:00:00Z',
    description: null,
    permissions: { push: true, admin: true },
    ...over,
  };
}

describe('listAccessibleRepos', () => {
  beforeEach(() => {
    mock.restore();
  });

  test('returns empty list when GitHub returns nothing', async () => {
    const fake = makeOctokit([[]]);
    mock.module('../src/github/api.ts', () => ({
      ...api,
      octokitFor: () => fake as unknown as ReturnType<typeof api.octokitFor>,
    }));
    const fresh = await import('../src/github/repos.ts?t=' + Date.now());
    const repos = await fresh.listAccessibleRepos('token');
    expect(repos).toEqual([]);
  });

  test('paginates until a short page is returned', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ghRepo({ full_name: `o/r${i}` }));
    const page2 = Array.from({ length: 25 }, (_, i) => ghRepo({ full_name: `o/r${100 + i}` }));
    const fake = makeOctokit([page1, page2]);
    mock.module('../src/github/api.ts', () => ({
      ...api,
      octokitFor: () => fake as unknown as ReturnType<typeof api.octokitFor>,
    }));
    const fresh = await import('../src/github/repos.ts?t=' + Date.now());
    const repos = await fresh.listAccessibleRepos('token');
    expect(repos).toHaveLength(125);
    expect(repos[0]!.fullName).toBe('o/r0');
    expect(repos.at(-1)!.fullName).toBe('o/r124');
  });

  test('projects nested fields safely', async () => {
    const fake = makeOctokit([
      [
        ghRepo({
          full_name: 'a/b',
          private: true,
          fork: true,
          archived: true,
          permissions: undefined,
          pushed_at: null,
        }),
      ],
    ]);
    mock.module('../src/github/api.ts', () => ({
      ...api,
      octokitFor: () => fake as unknown as ReturnType<typeof api.octokitFor>,
    }));
    const fresh = await import('../src/github/repos.ts?t=' + Date.now());
    const [r] = await fresh.listAccessibleRepos('token');
    expect(r).toBeDefined();
    expect(r!.fullName).toBe('a/b');
    expect(r!.private).toBe(true);
    expect(r!.fork).toBe(true);
    expect(r!.archived).toBe(true);
    expect(r!.pushedAt).toBe(null);
    expect(r!.permissions).toEqual({ push: false, admin: false });
  });
});

describe('filterRepos', () => {
  const repos: Repo[] = [
    repoFixture('foo/bar'),
    repoFixture('baz/qux'),
    repoFixture('foo/baz'),
  ];

  test('empty query returns all', () => {
    expect(filterRepos(repos, '')).toHaveLength(3);
    expect(filterRepos(repos, '   ')).toHaveLength(3);
  });

  test('matches by substring (case-insensitive)', () => {
    expect(filterRepos(repos, 'foo')).toHaveLength(2);
    expect(filterRepos(repos, 'BAZ').map((r) => r.fullName)).toEqual([
      'baz/qux',
      'foo/baz',
    ]);
  });

  test('returns empty when no match', () => {
    expect(filterRepos(repos, 'zzz')).toEqual([]);
  });
});

function repoFixture(fullName: string): Repo {
  return {
    fullName,
    defaultBranch: 'main',
    private: false,
    fork: false,
    archived: false,
    pushedAt: '2026-05-01T00:00:00Z',
    description: null,
    permissions: { push: true, admin: true },
  };
}
