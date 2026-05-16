import { describe, expect, test } from 'bun:test';
import {
  formatUserMessage,
  parseClaudeCliOutput,
  parseVerdict,
} from '../src/review/format.ts';

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

  test('chooses a fence longer than the longest backtick run inside the diff', () => {
    // A diff that itself contains "``````" (6 ticks) should be wrapped in
    // at least 7 ticks, so the closing fence still terminates the block.
    const diff = 'before\n``````\nfaux fence inside\n``````\nafter';
    const msg = formatUserMessage({
      scrutiny: 'standard',
      diff,
      prTitle: 't',
      prAuthor: 'a',
      repoFull: 'r/r',
    });
    expect(msg).toContain('```````diff');  // 7 backticks + "diff"
    expect(msg).toContain('\n```````');    // closing 7 backticks
  });

  test('uses 3-backtick fence when diff has no backticks', () => {
    const msg = formatUserMessage({
      scrutiny: 'standard',
      diff: '+ ok\n- nope',
      prTitle: 't',
      prAuthor: 'a',
      repoFull: 'r/r',
    });
    expect(msg).toContain('```diff');
  });

  test('renders the large-PR caveat before the diff when diffNotice is set', () => {
    const msg = formatUserMessage({
      scrutiny: 'standard',
      diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new',
      prTitle: 't',
      prAuthor: 'a',
      repoFull: 'r/r',
      diffNotice: 'Reviewed in FULL: 12 file(s). Listed by name only: 480.',
    });
    expect(msg).toContain('Large pull request — partial diff');
    expect(msg).toContain('Reviewed in FULL: 12 file(s)');
    // Caveat must appear before the fenced diff so the model reads it first.
    expect(msg.indexOf('Reviewed in FULL')).toBeLessThan(msg.indexOf('```diff'));
  });

  test('renders the injection CAUTION immediately before the diff', () => {
    const msg = formatUserMessage({
      scrutiny: 'standard',
      diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new',
      prTitle: 't',
      prAuthor: 'a',
      repoFull: 'r/r',
      signalsNote: 'some signal',
      injectionNote: 'Possible prompt-injection in untrusted PR input — instruction-override.',
    });
    expect(msg).toContain('> [!CAUTION] Possible prompt-injection');
    // After the signals NOTE but still before the fenced diff.
    expect(msg.indexOf('some signal')).toBeLessThan(msg.indexOf('[!CAUTION]'));
    expect(msg.indexOf('[!CAUTION]')).toBeLessThan(msg.indexOf('```diff'));
  });

  test('omits the CAUTION block when injectionNote is absent', () => {
    const msg = formatUserMessage({
      scrutiny: 'standard',
      diff: '+ ok',
      prTitle: 't',
      prAuthor: 'a',
      repoFull: 'r/r',
    });
    expect(msg).not.toContain('[!CAUTION]');
  });

  test('omits the caveat block entirely for a normal full diff', () => {
    const msg = formatUserMessage({
      scrutiny: 'standard',
      diff: '+ ok',
      prTitle: 't',
      prAuthor: 'a',
      repoFull: 'r/r',
      diffNotice: null,
    });
    expect(msg).not.toContain('partial diff');
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

  test('extracts verdict from result body', () => {
    const stdout = JSON.stringify({
      result: '<!-- arbiter:verdict=approve -->\n\nLooks good.',
    });
    const out = parseClaudeCliOutput(stdout);
    expect(out.verdict).toBe('approve');
    expect(out.body).toBe('Looks good.');
  });

  test('verdict defaults to "comment" when marker is missing', () => {
    const stdout = JSON.stringify({ result: 'No marker here.' });
    const out = parseClaudeCliOutput(stdout);
    expect(out.verdict).toBe('comment');
    expect(out.body).toBe('No marker here.');
  });
});

describe('parseVerdict', () => {
  test('parses each verdict value', () => {
    expect(parseVerdict('<!-- arbiter:verdict=approve -->\nbody').verdict).toBe('approve');
    expect(parseVerdict('<!-- arbiter:verdict=comment -->\nbody').verdict).toBe('comment');
    expect(parseVerdict('<!-- arbiter:verdict=request-changes -->\nbody').verdict).toBe('request-changes');
  });

  test('strips the marker and leading whitespace from the body', () => {
    const result = parseVerdict('<!-- arbiter:verdict=approve -->\n\nLooks fine.');
    expect(result.body).toBe('Looks fine.');
  });

  test('defaults to comment when marker is absent', () => {
    const result = parseVerdict('No marker here.');
    expect(result.verdict).toBe('comment');
    expect(result.body).toBe('No marker here.');
  });

  test('tolerates whitespace inside the marker', () => {
    expect(parseVerdict('<!--   arbiter:verdict=approve   -->\nbody').verdict).toBe('approve');
  });

  test('matches case-insensitively on the comment text', () => {
    expect(parseVerdict('<!-- ARBITER:VERDICT=approve -->\nbody').verdict).toBe('approve');
  });

  test('rejects unknown verdicts (falls back to comment)', () => {
    expect(parseVerdict('<!-- arbiter:verdict=lgtm -->\nbody').verdict).toBe('comment');
  });
});
