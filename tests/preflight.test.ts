import { describe, expect, test } from 'bun:test';
import { formatSubscriptionPreflightError } from '../src/review/runner.ts';
import { readEnvValue, upsertEnvLine } from '../scripts/setup.ts';

describe('formatSubscriptionPreflightError', () => {
  const out = formatSubscriptionPreflightError('claude -p did not respond within 30000ms');

  test('surfaces the underlying detail verbatim', () => {
    expect(out).toContain('claude -p did not respond within 30000ms');
  });

  test('covers all three host OS cases', () => {
    expect(out).toContain('Windows');
    expect(out).toContain('CLAUDE_HOST_DIR');
    expect(out).toContain('macOS');
    expect(out).toContain("security find-generic-password");
    expect(out).toContain('Linux');
    expect(out).toContain('.credentials.json');
  });

  test('points at the setup script and the api-mode escape hatch', () => {
    expect(out).toContain('bun run setup');
    expect(out).toContain('CLAUDE_DEFAULT_MODE=api');
  });
});

describe('upsertEnvLine', () => {
  test('appends when the key is absent', () => {
    const r = upsertEnvLine('FOO=1\n', 'CLAUDE_HOST_DIR', 'C:/Users/Will/.claude');
    expect(r).toBe('FOO=1\nCLAUDE_HOST_DIR=C:/Users/Will/.claude\n');
  });

  test('adds a separator when content lacks a trailing newline', () => {
    const r = upsertEnvLine('FOO=1', 'BAR', '2');
    expect(r).toBe('FOO=1\nBAR=2\n');
  });

  test('replaces in place, preserving other lines (incl. secrets)', () => {
    const src = 'SESSION_SECRET=abc123\nCLAUDE_HOST_DIR=/old\nPORT=8787\n';
    const r = upsertEnvLine(src, 'CLAUDE_HOST_DIR', '/new');
    expect(r).toBe('SESSION_SECRET=abc123\nCLAUDE_HOST_DIR=/new\nPORT=8787\n');
  });

  test('is idempotent', () => {
    const once = upsertEnvLine('FOO=1\n', 'BAR', '2');
    const twice = upsertEnvLine(once, 'BAR', '2');
    expect(twice).toBe(once);
    expect(twice.match(/^BAR=/gm)?.length).toBe(1);
  });

  test('handles empty content', () => {
    expect(upsertEnvLine('', 'BAR', '2')).toBe('BAR=2\n');
  });
});

describe('readEnvValue', () => {
  test('returns the trimmed value', () => {
    expect(readEnvValue('CLAUDE_DEFAULT_MODE=api \n', 'CLAUDE_DEFAULT_MODE')).toBe('api');
  });

  test('last occurrence wins', () => {
    expect(readEnvValue('X=1\nX=2\n', 'X')).toBe('2');
  });

  test('undefined when absent', () => {
    expect(readEnvValue('X=1\n', 'NOPE')).toBeUndefined();
  });
});
