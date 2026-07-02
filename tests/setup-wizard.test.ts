import { describe, expect, test } from 'bun:test';
import { resolveEffective, verifySetupCode, getSetupCode } from '../src/settings.ts';
import { parseSetupForm } from '../src/web/setup.ts';
import { buildApp } from '../src/web/server.tsx';

describe('resolveEffective', () => {
  test('env wins when set', () => {
    expect(resolveEffective('from-env', 'from-db')).toBe('from-env');
  });

  test('db fills the blank', () => {
    expect(resolveEffective('', 'from-db')).toBe('from-db');
  });

  test('both blank stays blank', () => {
    expect(resolveEffective('', '')).toBe('');
  });
});

describe('parseSetupForm', () => {
  const valid = {
    github_client_id: 'Ov23liAbCdEf12345678',
    github_client_secret: 'ffffffffffffffffffffffffffffffffffffffff',
    claude_code_oauth_token: 'sk-ant-oat01-abcdefghijklmnop',
    github_webhook_secret: '',
  };

  test('accepts a complete valid form', () => {
    const r = parseSetupForm(valid, { claudeTokenRequired: true });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.values.githubClientId).toBe(valid.github_client_id);
  });

  test('trims whitespace around values', () => {
    const r = parseSetupForm(
      { ...valid, github_client_id: '  Ov23liAbCdEf12345678  ' },
      { claudeTokenRequired: true },
    );
    expect(r.ok).toBe(true);
    expect(r.values.githubClientId).toBe('Ov23liAbCdEf12345678');
  });

  test('requires client id and secret', () => {
    const r = parseSetupForm(
      { ...valid, github_client_id: '', github_client_secret: '' },
      { claudeTokenRequired: true },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('client ID'))).toBe(true);
    expect(r.errors.some((e) => e.includes('client secret'))).toBe(true);
  });

  test('rejects internal whitespace in credentials', () => {
    const r = parseSetupForm(
      { ...valid, github_client_id: 'Ov23li AbCdEf' },
      { claudeTokenRequired: true },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('whitespace'))).toBe(true);
  });

  test('token required when the instance has no env-provided credentials', () => {
    const r = parseSetupForm(
      { ...valid, claude_code_oauth_token: '' },
      { claudeTokenRequired: true },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('setup-token'))).toBe(true);
  });

  test('token optional when env already provides credentials', () => {
    const r = parseSetupForm(
      { ...valid, claude_code_oauth_token: '' },
      { claudeTokenRequired: false },
    );
    expect(r.ok).toBe(true);
  });

  test('rejects a token that does not look like claude setup-token output', () => {
    const r = parseSetupForm(
      { ...valid, claude_code_oauth_token: 'hunter2' },
      { claudeTokenRequired: true },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('sk-ant-oat'))).toBe(true);
  });

  test('missing fields behave as empty (no crash)', () => {
    const r = parseSetupForm({}, { claudeTokenRequired: true });
    expect(r.ok).toBe(false);
    expect(r.values).toEqual({
      githubClientId: '',
      githubClientSecret: '',
      claudeToken: '',
      webhookSecret: '',
    });
  });
});

describe('setup code', () => {
  test('accepts the real code, rejects others', () => {
    const code = getSetupCode();
    expect(verifySetupCode(code)).toBe(true);
    expect(verifySetupCode('nope')).toBe(false);
    expect(verifySetupCode(code.slice(0, -1) + (code.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(verifySetupCode('')).toBe(false);
  });
});

describe('setup routes on a configured instance', () => {
  // tests/setup.ts forces GITHUB_CLIENT_ID/SECRET into the env, so
  // setupNeeded() is false: the wizard must step aside entirely.
  test('GET /setup redirects home', async () => {
    const app = buildApp();
    const res = await app.request('/setup');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  test('gate does not intercept normal routes', async () => {
    const app = buildApp();
    const res = await app.request('/me');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });
});
