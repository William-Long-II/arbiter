import { describe, expect, test } from 'bun:test';
import { parseScopeForm } from '../src/db/scopes.ts';

describe('parseScopeForm', () => {
  test('happy path: minimal valid form', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'owner/name',
      base_branch_pattern: 'main',
      scrutiny: 'standard',
      claude_mode: 'default',
      enabled: 'on',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.targetKind).toBe('repo');
    expect(r.input.target).toBe('owner/name');
    expect(r.input.baseBranchPattern).toBe('main');
    expect(r.input.scrutiny).toBe('standard');
    expect(r.input.claudeMode).toBe('default');
    expect(r.input.enabled).toBe(true);
    expect(r.input.excludeAuthors).toEqual([]);
  });

  test('incremental_rereview checkbox maps to the flag (absent = off)', () => {
    const base = {
      target_kind: 'repo',
      target: 'owner/name',
      scrutiny: 'standard',
    };
    const on = parseScopeForm({ ...base, incremental_rereview: 'on' });
    const off = parseScopeForm(base);
    if (!on.ok || !off.ok) throw new Error('unreachable');
    expect(on.input.incrementalRereview).toBe(true);
    expect(off.input.incrementalRereview).toBe(false);
  });

  test('defaults base_branch_pattern to "*" when blank', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      base_branch_pattern: '   ',
      scrutiny: 'light',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.baseBranchPattern).toBe('*');
  });

  test('parses excluded authors line-by-line, trims, drops blanks', () => {
    const r = parseScopeForm({
      target_kind: 'org',
      target: 'acme',
      scrutiny: 'standard',
      exclude_authors: 'dependabot[bot]\n\n  renovate[bot]\nme\n',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.excludeAuthors).toEqual(['dependabot[bot]', 'renovate[bot]', 'me']);
  });

  test('checkbox: missing value ⇒ disabled', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
      // no `enabled` key (browsers omit unchecked checkboxes)
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.enabled).toBe(false);
  });

  test('rejects empty target', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: '',
      scrutiny: 'standard',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.errors).toContain('Target is required.');
  });

  test('rejects repo target without slash', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'just-a-name',
      scrutiny: 'standard',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.errors.join(' ')).toContain('owner/name');
  });

  test('rejects repo target with extra slashes', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'owner/name/extra',
      scrutiny: 'standard',
    });
    expect(r.ok).toBe(false);
  });

  test('rejects repo target with empty owner or name', () => {
    expect(parseScopeForm({ target_kind: 'repo', target: '/name', scrutiny: 'standard' }).ok).toBe(false);
    expect(parseScopeForm({ target_kind: 'repo', target: 'owner/', scrutiny: 'standard' }).ok).toBe(false);
  });

  test('accepts org target without slash', () => {
    const r = parseScopeForm({
      target_kind: 'org',
      target: 'acme',
      scrutiny: 'standard',
    });
    expect(r.ok).toBe(true);
  });

  test('rejects org target containing slashes', () => {
    const r = parseScopeForm({
      target_kind: 'org',
      target: 'acme/foo',
      scrutiny: 'standard',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.errors.join(' ')).toContain('no slashes');
  });

  test('rejects unknown scrutiny', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'lethal',
    });
    expect(r.ok).toBe(false);
  });

  test('rejects unknown target_kind', () => {
    const r = parseScopeForm({
      target_kind: 'team',
      target: 'a/b',
      scrutiny: 'standard',
    });
    expect(r.ok).toBe(false);
  });

  test('rejects unknown claude_mode', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
      claude_mode: 'gpt',
    });
    expect(r.ok).toBe(false);
  });

  test('claude_mode defaults to "default" when omitted', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.claudeMode).toBe('default');
  });

  test('auto_approve: missing ⇒ false', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
      enabled: 'on',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.autoApprove).toBe(false);
  });

  test('auto_approve: checked ⇒ true', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
      auto_approve: 'on',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.autoApprove).toBe(true);
  });

  test('gate_on_blocking: missing ⇒ false, checked ⇒ true', () => {
    const off = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
    });
    expect(off.ok).toBe(true);
    if (!off.ok) throw new Error('unreachable');
    expect(off.input.gateOnBlocking).toBe(false);

    const on = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
      gate_on_blocking: 'on',
    });
    expect(on.ok).toBe(true);
    if (!on.ok) throw new Error('unreachable');
    expect(on.input.gateOnBlocking).toBe(true);
  });

  test('personality_prompt: missing ⇒ null', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.personalityPrompt).toBeNull();
  });

  test('personality_prompt: trims trailing whitespace', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
      personality_prompt: 'be terse  \n\n  ',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.personalityPrompt).toBe('be terse');
  });

  test('personality_prompt: blank string ⇒ null', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
      personality_prompt: '   \n\n  ',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.personalityPrompt).toBeNull();
  });

  test('trigger_mode defaults to "open" when omitted', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.triggerMode).toBe('open');
  });

  test('trigger_mode accepts review_requested', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
      trigger_mode: 'review_requested',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.triggerMode).toBe('review_requested');
  });

  test('rejects unknown trigger_mode', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
      trigger_mode: 'mentioned',
    });
    expect(r.ok).toBe(false);
  });

  test('review_context defaults to "isolated" when omitted', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.reviewContext).toBe('isolated');
  });

  test('review_context accepts checkout', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
      review_context: 'checkout',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.input.reviewContext).toBe('checkout');
  });

  test('rejects unknown review_context', () => {
    const r = parseScopeForm({
      target_kind: 'repo',
      target: 'a/b',
      scrutiny: 'standard',
      review_context: 'sandbox',
    });
    expect(r.ok).toBe(false);
  });
});
