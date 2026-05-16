import { describe, expect, test } from 'bun:test';
import { parseInstallationEvent } from '../src/github/webhook.ts';

const inst = (action: string, over: Record<string, unknown> = {}) => ({
  action,
  installation: {
    id: 555,
    account: { login: 'acme', type: 'Organization' },
    ...over,
  },
});

describe('parseInstallationEvent', () => {
  test('created / new_permissions_accepted → upsert', () => {
    for (const a of ['created', 'new_permissions_accepted']) {
      const r = parseInstallationEvent('installation', inst(a))!;
      expect(r.kind).toBe('upsert');
      expect(r.installationId).toBe(555);
      expect(r.accountLogin).toBe('acme');
      expect(r.accountType).toBe('Organization');
    }
  });

  test('deleted → remove; suspend/unsuspend → suspend/unsuspend', () => {
    expect(parseInstallationEvent('installation', inst('deleted'))!.kind).toBe('remove');
    expect(parseInstallationEvent('installation', inst('suspend'))!.kind).toBe('suspend');
    expect(parseInstallationEvent('installation', inst('unsuspend'))!.kind).toBe(
      'unsuspend',
    );
  });

  test('ignores non-installation events and uninteresting actions', () => {
    expect(parseInstallationEvent('pull_request', inst('created'))).toBeNull();
    expect(parseInstallationEvent('installation', inst('edited'))).toBeNull();
    expect(parseInstallationEvent('installation_repositories', inst('added'))).toBeNull();
  });

  test('rejects payloads missing the installation id', () => {
    expect(
      parseInstallationEvent('installation', { action: 'created', installation: {} }),
    ).toBeNull();
    expect(
      parseInstallationEvent('installation', {
        action: 'created',
        installation: { id: 0, account: { login: 'x' } },
      }),
    ).toBeNull();
    expect(parseInstallationEvent('installation', null)).toBeNull();
    expect(parseInstallationEvent('installation', 'nope')).toBeNull();
  });

  test('upsert needs a login; remove/suspend tolerate its absence', () => {
    const noLogin = { id: 9, account: { type: 'User' } };
    expect(
      parseInstallationEvent('installation', { action: 'created', installation: noLogin }),
    ).toBeNull();
    const rm = parseInstallationEvent('installation', {
      action: 'deleted',
      installation: noLogin,
    })!;
    expect(rm.kind).toBe('remove');
    expect(rm.installationId).toBe(9);
    expect(rm.accountLogin).toBe('');
    expect(rm.accountType).toBe('User');
  });
});
