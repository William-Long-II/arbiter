import { describe, expect, test, mock, beforeEach } from 'bun:test';
import * as api from '../src/github/api.ts';
import { filterRepos, type Repo } from '../src/github/repos.ts';

type FakeOctokit = ReturnType<typeof makeOctokit>;

function makeOctokit(opts: {
  userPages?: Array<Array<Record<string, unknown>>>;
  userError?: Error;
  orgsPages?: Array<Array<Record<string, unknown>>>;
  orgsError?: Error;
  orgRepos?: Record<string, Array<Array<Record<string, unknown>>>>;
  orgErrors?: Record<string, Error>;
}) {
  const userPages = opts.userPages ?? [[]];
  const orgsPages = opts.orgsPages ?? [[]];
  const orgRepos = opts.orgRepos ?? {};
  const orgErrors = opts.orgErrors ?? {};
  let userCall = 0;
  let orgsCall = 0;
  const orgRepoCalls = new Map<string, number>();

  return {
    rest: {
      repos: {
        listForAuthenticatedUser: mock(async () => {
          if (opts.userError) throw opts.userError;
          const data = userPages[userCall] ?? [];
          userCall++;
          return { data };
        }),
        listForOrg: mock(async ({ org }: { org: string }) => {
          if (orgErrors[org]) throw orgErrors[org];
          const pages = orgRepos[org] ?? [[]];
          const idx = orgRepoCalls.get(org) ?? 0;
          orgRepoCalls.set(org, idx + 1);
          const data = pages[idx] ?? [];
          return { data };
        }),
      },
      orgs: {
        listForAuthenticatedUser: mock(async () => {
          if (opts.orgsError) throw opts.orgsError;
          const data = orgsPages[orgsCall] ?? [];
          orgsCall++;
          return { data };
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

function ghOrg(login: string) {
  return { login };
}

async function freshListAccessibleRepos(fake: FakeOctokit) {
  mock.module('../src/github/api.ts', () => ({
    ...api,
    octokitFor: () => fake as unknown as ReturnType<typeof api.octokitFor>,
  }));
  const fresh = await import('../src/github/repos.ts?t=' + Date.now() + Math.random());
  return fresh.listAccessibleRepos('token');
}

describe('listAccessibleRepos — user repos only', () => {
  beforeEach(() => mock.restore());

  test('empty user list with no orgs', async () => {
    const fake = makeOctokit({});
    const { repos, sources } = await freshListAccessibleRepos(fake);
    expect(repos).toEqual([]);
    expect(sources).toEqual([{ kind: 'user', status: 'ok', count: 0 }]);
  });

  test('paginates user repos until short page', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ghRepo({ full_name: `o/r${i}` }));
    const page2 = Array.from({ length: 25 }, (_, i) => ghRepo({ full_name: `o/r${100 + i}` }));
    const fake = makeOctokit({ userPages: [page1, page2] });
    const { repos } = await freshListAccessibleRepos(fake);
    expect(repos).toHaveLength(125);
  });

  test('user list error is captured in sources', async () => {
    const fake = makeOctokit({ userError: new Error('rate-limited') });
    const { repos, sources } = await freshListAccessibleRepos(fake);
    expect(repos).toEqual([]);
    expect(sources).toEqual([
      { kind: 'user', status: 'error', count: 0, error: 'rate-limited' },
    ]);
  });
});

describe('listAccessibleRepos — org fan-out', () => {
  beforeEach(() => mock.restore());

  test('includes org repos missing from /user/repos', async () => {
    const fake = makeOctokit({
      userPages: [[ghRepo({ full_name: 'me/personal' })]],
      orgsPages: [[ghOrg('acme'), ghOrg('beta-org')]],
      orgRepos: {
        acme: [[ghRepo({ full_name: 'acme/one' }), ghRepo({ full_name: 'acme/two' })]],
        'beta-org': [[ghRepo({ full_name: 'beta-org/x' })]],
      },
    });
    const { repos, sources } = await freshListAccessibleRepos(fake);
    expect(repos.map((r: Repo) => r.fullName).sort()).toEqual([
      'acme/one',
      'acme/two',
      'beta-org/x',
      'me/personal',
    ]);
    expect(sources).toEqual([
      { kind: 'user', status: 'ok', count: 1 },
      { kind: 'org', org: 'acme', status: 'ok', count: 2 },
      { kind: 'org', org: 'beta-org', status: 'ok', count: 1 },
    ]);
  });

  test('dedupes when same repo appears in user and org listings', async () => {
    const fake = makeOctokit({
      userPages: [[ghRepo({ full_name: 'acme/shared' })]],
      orgsPages: [[ghOrg('acme')]],
      orgRepos: {
        acme: [[ghRepo({ full_name: 'acme/shared' }), ghRepo({ full_name: 'acme/extra' })]],
      },
    });
    const { repos } = await freshListAccessibleRepos(fake);
    expect(repos.map((r: Repo) => r.fullName).sort()).toEqual(['acme/extra', 'acme/shared']);
  });

  test('org returning empty surfaces status: empty (the OAuth-approval hint)', async () => {
    const fake = makeOctokit({
      userPages: [[]],
      orgsPages: [[ghOrg('locked-org')]],
      orgRepos: { 'locked-org': [[]] },
    });
    const { repos, sources } = await freshListAccessibleRepos(fake);
    expect(repos).toEqual([]);
    expect(sources).toContainEqual({
      kind: 'org',
      org: 'locked-org',
      status: 'empty',
      count: 0,
    });
  });

  test('per-org error is isolated — other orgs still listed', async () => {
    const fake = makeOctokit({
      userPages: [[]],
      orgsPages: [[ghOrg('broken'), ghOrg('working')]],
      orgErrors: { broken: new Error('403 forbidden') },
      orgRepos: { working: [[ghRepo({ full_name: 'working/r' })]] },
    });
    const { repos, sources } = await freshListAccessibleRepos(fake);
    expect(repos.map((r: Repo) => r.fullName)).toEqual(['working/r']);
    expect(sources).toContainEqual({
      kind: 'org',
      org: 'broken',
      status: 'error',
      count: 0,
      error: '403 forbidden',
    });
    expect(sources).toContainEqual({
      kind: 'org',
      org: 'working',
      status: 'ok',
      count: 1,
    });
  });

  test('orgs listing error degrades silently — user repos still returned', async () => {
    const fake = makeOctokit({
      userPages: [[ghRepo({ full_name: 'me/r' })]],
      orgsError: new Error('orgs forbidden'),
    });
    const { repos, sources } = await freshListAccessibleRepos(fake);
    expect(repos.map((r: Repo) => r.fullName)).toEqual(['me/r']);
    expect(sources).toEqual([{ kind: 'user', status: 'ok', count: 1 }]);
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
