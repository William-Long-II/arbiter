import { describe, expect, test } from 'bun:test';
import { resolveRepoToken } from '../src/github/resolve-token.ts';

const OAUTH = 'gho_oauthtoken';

describe('resolveRepoToken', () => {
  test('App not configured → OAuth token, unchanged', async () => {
    const r = await resolveRepoToken('acme/widget', OAUTH, {
      configured: () => false,
      lookup: async () => {
        throw new Error('must not be called');
      },
    });
    expect(r).toEqual({ token: OAUTH, source: 'oauth' });
  });

  test('configured but no installation for the owner → OAuth', async () => {
    const r = await resolveRepoToken('acme/widget', OAUTH, {
      configured: () => true,
      lookup: async () => null,
    });
    expect(r).toEqual({ token: OAUTH, source: 'oauth' });
  });

  test('configured + installation found → minted installation token', async () => {
    let askedOwner = '';
    let mintedId = 0;
    const r = await resolveRepoToken('Acme/Widget', OAUTH, {
      configured: () => true,
      lookup: async (owner) => {
        askedOwner = owner;
        return { installationId: 4242 };
      },
      mint: async (id) => {
        mintedId = id;
        return { token: 'ghs_installationtoken' };
      },
    });
    expect(askedOwner).toBe('Acme'); // owner = first path segment
    expect(mintedId).toBe(4242);
    expect(r).toEqual({ token: 'ghs_installationtoken', source: 'app-installation' });
  });

  test('lookup error degrades to OAuth (never fails the review)', async () => {
    const r = await resolveRepoToken('acme/widget', OAUTH, {
      configured: () => true,
      lookup: async () => {
        throw new Error('db down');
      },
    });
    expect(r).toEqual({ token: OAUTH, source: 'oauth' });
  });

  test('mint error degrades to OAuth (never fails the review)', async () => {
    const r = await resolveRepoToken('acme/widget', OAUTH, {
      configured: () => true,
      lookup: async () => ({ installationId: 7 }),
      mint: async () => {
        throw new Error('GitHub 503 on access_tokens');
      },
    });
    expect(r).toEqual({ token: OAUTH, source: 'oauth' });
  });

  test('malformed repoFull (no owner segment) → OAuth', async () => {
    const r = await resolveRepoToken('', OAUTH, {
      configured: () => true,
      lookup: async () => {
        throw new Error('must not be called');
      },
    });
    expect(r).toEqual({ token: OAUTH, source: 'oauth' });
  });
});
