import { describe, expect, test, mock, beforeEach } from 'bun:test';
import * as api from '../src/github/api.ts';

function makeOctokit() {
  const userPages: Array<Array<Record<string, unknown>>> = [
    [{ full_name: 'me/r', default_branch: 'main', private: false, fork: false, archived: false, pushed_at: null }],
  ];
  let userCall = 0;
  return {
    rest: {
      repos: {
        listForAuthenticatedUser: mock(async () => {
          const data = userPages[userCall] ?? [];
          userCall++;
          return { data };
        }),
        listForOrg: mock(async () => ({ data: [] })),
      },
      orgs: {
        listForAuthenticatedUser: mock(async () => ({ data: [] })),
      },
    },
  };
}

async function freshModule() {
  return import('../src/github/repos.ts?cache-bust=' + Date.now() + Math.random());
}

describe('listAccessibleReposCached', () => {
  beforeEach(() => mock.restore());

  test('first call hits the API; second call within TTL is served from cache', async () => {
    const fake = makeOctokit();
    mock.module('../src/github/api.ts', () => ({
      ...api,
      octokitFor: () => fake as unknown as ReturnType<typeof api.octokitFor>,
    }));
    const repos = await freshModule();
    await repos.listAccessibleReposCached(1, 'tok');
    await repos.listAccessibleReposCached(1, 'tok');
    expect(fake.rest.repos.listForAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  test('different user IDs maintain separate cache entries', async () => {
    const fake = makeOctokit();
    mock.module('../src/github/api.ts', () => ({
      ...api,
      octokitFor: () => fake as unknown as ReturnType<typeof api.octokitFor>,
    }));
    const repos = await freshModule();
    await repos.listAccessibleReposCached(1, 'tok-a');
    await repos.listAccessibleReposCached(2, 'tok-b');
    expect(fake.rest.repos.listForAuthenticatedUser).toHaveBeenCalledTimes(2);
  });

  test('refresh: true bypasses the cache', async () => {
    const fake = makeOctokit();
    mock.module('../src/github/api.ts', () => ({
      ...api,
      octokitFor: () => fake as unknown as ReturnType<typeof api.octokitFor>,
    }));
    const repos = await freshModule();
    await repos.listAccessibleReposCached(1, 'tok');
    await repos.listAccessibleReposCached(1, 'tok', { refresh: true });
    expect(fake.rest.repos.listForAuthenticatedUser).toHaveBeenCalledTimes(2);
  });

  test('invalidateRepoCache forces a refetch', async () => {
    const fake = makeOctokit();
    mock.module('../src/github/api.ts', () => ({
      ...api,
      octokitFor: () => fake as unknown as ReturnType<typeof api.octokitFor>,
    }));
    const repos = await freshModule();
    await repos.listAccessibleReposCached(1, 'tok');
    repos.invalidateRepoCache(1);
    await repos.listAccessibleReposCached(1, 'tok');
    expect(fake.rest.repos.listForAuthenticatedUser).toHaveBeenCalledTimes(2);
  });
});
