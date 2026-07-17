import { describe, expect, test } from 'bun:test';
import { buildSkillSystemPrompt, CONTEXT_PROMPT } from '../src/review/runner.ts';
import { AUTO_APPROVE_VERDICT_INSTRUCTION } from '../src/review/format.ts';

// The 'isolated' wording is the actual fix for the user-reported
// "the working directory contains an unrelated project" caveats: the
// model must be told it has only the diff and must not hedge that way.
describe('CONTEXT_PROMPT', () => {
  test('isolated wording forbids working-directory / unverifiable caveats', () => {
    const p = CONTEXT_PROMPT.isolated;
    expect(p).toContain('diff in the user message ONLY');
    expect(p).toMatch(/do not attempt to read files/i);
    expect(p).toMatch(/unrelated project/i);
    expect(p).toMatch(/Do NOT add caveats/i);
  });

  test('checkout wording tells the model it has a working tree', () => {
    const p = CONTEXT_PROMPT.checkout;
    expect(p).toMatch(/checked out at its head commit/i);
    expect(p).toMatch(/verify cross-module references/i);
    // Must not also carry the "no working tree" isolated instruction.
    expect(p).not.toMatch(/working directory is intentionally empty/i);
  });

  test('both are additive notes, not full prompts (no verdict rules)', () => {
    // They get appended to the scrutiny base prompt, which owns output
    // format — the context note must not redefine it.
    expect(CONTEXT_PROMPT.isolated).not.toMatch(/arbiter:verdict/i);
    expect(CONTEXT_PROMPT.checkout).not.toMatch(/arbiter:verdict/i);
  });
});

describe('auto-approve binary-verdict instruction', () => {
  test('forbids the comment fence and demands one of the two real verdicts', () => {
    const p = AUTO_APPROVE_VERDICT_INSTRUCTION;
    expect(p).toMatch(/NEVER `comment`/);
    expect(p).toContain('`approve` or `request-changes`');
    expect(p).toMatch(/blocking >= 1/);
  });

  test('skill prompt includes it only for auto-approve scopes', () => {
    const withIt = buildSkillSystemPrompt('some-skill', 'isolated', null, true);
    const withoutIt = buildSkillSystemPrompt('some-skill', 'isolated', null, false);
    expect(withIt).toContain(AUTO_APPROVE_VERDICT_INSTRUCTION);
    expect(withoutIt).not.toContain('BINARY VERDICT');
  });
});
