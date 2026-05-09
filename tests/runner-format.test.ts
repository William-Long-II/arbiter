import { describe, expect, test } from 'bun:test';
import { formatUserMessage, parseClaudeCliOutput } from '../src/review/format.ts';

describe('formatUserMessage', () => {
  test('includes PR metadata and fenced diff', () => {
    const msg = formatUserMessage({
      scrutiny: 'standard',
      diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new',
      prTitle: 'Refactor X',
      prAuthor: 'octocat',
      repoFull: 'acme/widget',
    });
    expect(msg).toContain('Repository: acme/widget');
    expect(msg).toContain('PR title: Refactor X');
    expect(msg).toContain('Author: octocat');
    expect(msg).toContain('Scrutiny tier: standard');
    expect(msg).toContain('```diff');
    expect(msg).toContain('--- a/x');
    expect(msg).toContain('+new');
  });

  test('preserves diff content verbatim (does not collapse whitespace)', () => {
    const diff = 'line1\n  indented\n\nblank line above';
    const msg = formatUserMessage({
      scrutiny: 'light',
      diff,
      prTitle: 't',
      prAuthor: 'a',
      repoFull: 'r/r',
    });
    expect(msg).toContain(diff);
  });
});

describe('parseClaudeCliOutput', () => {
  test('extracts result and total_cost_usd', () => {
    const stdout = JSON.stringify({
      result: 'Looks fine.',
      session_id: 'abc',
      total_cost_usd: 0.0123,
    });
    const out = parseClaudeCliOutput(stdout);
    expect(out.body).toBe('Looks fine.');
    expect(out.costUsd).toBe(0.0123);
    expect(out.raw).toBeDefined();
  });

  test('cost is omitted when not in payload', () => {
    const stdout = JSON.stringify({ result: 'OK', session_id: 's' });
    const out = parseClaudeCliOutput(stdout);
    expect(out.body).toBe('OK');
    expect(out.costUsd).toBeUndefined();
  });

  test('throws on empty stdout', () => {
    expect(() => parseClaudeCliOutput('')).toThrow('empty stdout');
    expect(() => parseClaudeCliOutput('   ')).toThrow('empty stdout');
  });

  test('throws on non-JSON output', () => {
    expect(() => parseClaudeCliOutput('not json')).toThrow('non-JSON');
  });

  test('throws when result is missing', () => {
    expect(() => parseClaudeCliOutput(JSON.stringify({ session_id: 'x' }))).toThrow(
      'no "result" string',
    );
  });

  test('throws when result is empty', () => {
    expect(() => parseClaudeCliOutput(JSON.stringify({ result: '' }))).toThrow(
      'no "result" string',
    );
  });

  test('throws when result is not a string', () => {
    expect(() => parseClaudeCliOutput(JSON.stringify({ result: 42 }))).toThrow(
      'no "result" string',
    );
  });

  test('trims wrapping whitespace before parsing', () => {
    const stdout = '\n\n' + JSON.stringify({ result: 'OK' }) + '\n';
    expect(parseClaudeCliOutput(stdout).body).toBe('OK');
  });
});
