import { describe, expect, test } from 'bun:test';
import {
  buildHumanizeSystemPrompt,
  buildSkillSystemPrompt,
} from '../src/review/runner.ts';
import { parseScopeForm } from '../src/db/scopes.ts';

describe('buildHumanizeSystemPrompt', () => {
  const VOICE = 'Terse, no preamble. Sound like a senior who has seen this exact pattern before.';
  const prompt = buildHumanizeSystemPrompt(VOICE);

  test('embeds the personality verbatim under the Voice heading', () => {
    expect(prompt).toContain('## Voice');
    expect(prompt).toContain(VOICE);
  });

  test('forbids substance changes — the rewrite must not invent or drop findings', () => {
    // Without these guardrails the model will helpfully "clean up" the
    // review and merge two findings, or invent a third because the voice
    // sounds like it would say one. Substance-preservation is the whole
    // contract of the humanize pass.
    expect(prompt).toMatch(/do NOT add new findings/i);
    expect(prompt).toMatch(/remove existing ones/i);
    expect(prompt).toMatch(/change their\s+severity/i);
  });

  test('forbids a preamble — output is the rewritten review only, nothing else', () => {
    // Without this, models love to lead with "Here is the rewritten
    // review:" or wrap the whole thing in a markdown fence — both of
    // which break the GitHub render and the downstream marker parses.
    expect(prompt).toMatch(/Output ONLY the\s+rewritten review/i);
    expect(prompt).toMatch(/no fences\s+wrapping the whole thing/i);
  });

  test('keeps code references, paths, line numbers, and links intact', () => {
    // The skill emits findings with `src/foo.ts:42` anchors and links —
    // a rewrite that paraphrases "src/foo.ts:42" into "the foo file" is
    // useless. Spell out the things that must survive verbatim.
    expect(prompt).toContain('file path');
    expect(prompt).toContain('line number');
    expect(prompt).toContain('link');
    expect(prompt).toContain('code fence');
  });
});

describe('buildSkillSystemPrompt personality', () => {
  test('appends personality under "Additional reviewer guidance" when set', () => {
    const out = buildSkillSystemPrompt(
      'bmad-code-review',
      'isolated',
      'Sound like the user — terse, no emoji, no headings.',
    );
    expect(out).toContain('Additional reviewer guidance for this scope');
    expect(out).toContain('Sound like the user');
  });

  test('omits the section entirely when personality is null/undefined/empty', () => {
    // The section header is a stable lookup string; if it ever ships
    // without a body, every skill review pays a token tax for an empty
    // heading. Verify the heading is absent so the prompt stays lean.
    const noPersonality = buildSkillSystemPrompt('bmad-code-review', 'isolated');
    const emptyPersonality = buildSkillSystemPrompt('bmad-code-review', 'isolated', '');
    const whitespacePersonality = buildSkillSystemPrompt('bmad-code-review', 'isolated', '   \n');
    for (const out of [noPersonality, emptyPersonality, whitespacePersonality]) {
      expect(out).not.toContain('Additional reviewer guidance for this scope');
    }
  });

  test('still pins arbiter\'s output contract when personality is set — voice must not override format', () => {
    // The whole point of the skill-driven path is that verdict/findings/
    // items markers still parse. A personality that says "no markdown
    // comments" must not let the model silently drop them. The
    // FINDINGS_INSTRUCTION + ITEMS_INSTRUCTION block stays in the prompt
    // regardless of personality.
    const out = buildSkillSystemPrompt(
      'bmad-code-review',
      'isolated',
      'No HTML comments. No machine-readable markers. Just prose.',
    );
    expect(out).toContain('arbiter:findings=');
    expect(out).toContain('arbiter:items');
  });
});

describe('parseScopeForm humanize', () => {
  // The full set of fields parseScopeForm needs; we only vary the two we
  // care about per-test. Centralized so test bodies stay focused on the
  // humanize/personality interaction.
  function form(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      target_kind: 'repo',
      target: 'acme/widget',
      base_branch_pattern: 'main',
      scrutiny: 'standard',
      claude_mode: 'default',
      trigger_mode: 'open',
      review_context: 'isolated',
      footer_mode: 'standard',
      enabled: 'on',
      ...over,
    };
  }

  test('humanize=on + non-empty personality → true', () => {
    const r = parseScopeForm(form({ humanize: 'on', personality_prompt: 'be terse' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.humanize).toBe(true);
  });

  test('humanize=on but personality is blank → coerced to false (avoids the wasted LLM call)', () => {
    // A humanize pass without a personality has nothing to apply, so the
    // parser refuses to persist that combination. Verifies the
    // "meaningless flag gets silently dropped" rule, not just stored.
    const r = parseScopeForm(form({ humanize: 'on', personality_prompt: '' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.humanize).toBe(false);
      expect(r.input.personalityPrompt).toBeNull();
    }
  });

  test('humanize unchecked → false even with personality', () => {
    const r = parseScopeForm(form({ personality_prompt: 'be terse' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.humanize).toBe(false);
  });

  test('humanize=on with whitespace-only personality → coerced to false', () => {
    const r = parseScopeForm(
      form({ humanize: 'on', personality_prompt: '   \n   \t  ' }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.humanize).toBe(false);
      expect(r.input.personalityPrompt).toBeNull();
    }
  });
});
