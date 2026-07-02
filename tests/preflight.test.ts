import { describe, expect, test } from 'bun:test';
import { classifyPreflight, formatSubscriptionPreflightError } from '../src/review/runner.ts';
import { readEnvValue, upsertEnvLine } from '../scripts/setup.ts';

describe('classifyPreflight', () => {
  test('exit 0 is success', () => {
    const r = classifyPreflight({ exitCode: 0, timedOut: false, stdout: '', stderr: '' });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('responded');
  });

  test('watchdog fires → "did not respond within"', () => {
    const r = classifyPreflight({ exitCode: 137, timedOut: true, stdout: '', stderr: '' });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('did not respond within');
    expect(r.detail).toContain('hanging');
  });

  test('fast non-zero exit is NOT misreported as a timeout — surfaces stdout (where claude -p emits JSON failures)', () => {
    // Reproduces the original bug: `claude -p --output-format json` exited
    // in ~2s with a 401 on stdout and an empty stderr. The pre-fix code
    // saw `proc.killed === true` and reported "did not respond within
    // 30000ms"; the fix routes through this classifier with timedOut=false.
    const r = classifyPreflight({
      exitCode: 1,
      timedOut: false,
      stdout: '{"result":"Failed to authenticate. API Error: 401 Invalid authentication credentials"}',
      stderr: '',
    });
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain('did not respond within');
    expect(r.detail).toContain('exited 1');
    expect(r.detail).toContain('401');
  });

  test('falls back to stderr when stdout is empty', () => {
    const r = classifyPreflight({ exitCode: 2, timedOut: false, stdout: '', stderr: 'boom' });
    expect(r.detail).toBe('claude -p exited 2: boom');
  });

  test('falls back to (no output) when both streams are empty', () => {
    const r = classifyPreflight({ exitCode: 2, timedOut: false, stdout: '   ', stderr: '' });
    expect(r.detail).toBe('claude -p exited 2: (no output)');
  });
});

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

  test('leads with the headless token path', () => {
    expect(out).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(out).toContain('claude setup-token');
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
