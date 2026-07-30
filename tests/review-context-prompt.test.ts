import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSkillSystemPrompt, CONTEXT_PROMPT } from '../src/review/runner.ts';
import {
  AUTO_APPROVE_VERDICT_INSTRUCTION,
  EVIDENCE_GUARD,
} from '../src/review/format.ts';

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

// Regression cover for a real false positive: a review asserted what a call
// site twelve lines below the shown hunk passed, got it backwards, and
// posted the resulting question as a merge-blocking `request-changes` the
// author could not clear by answering it.
describe('EVIDENCE_GUARD', () => {
  test('forbids asserting code that was never shown', () => {
    expect(EVIDENCE_GUARD).toMatch(/Never state what code you have not been/);
    expect(EVIDENCE_GUARD).toMatch(/is a QUESTION/);
    expect(EVIDENCE_GUARD).toMatch(/do NOT count it as blocking/);
  });

  test('bars a request for confirmation from being a blocker', () => {
    expect(EVIDENCE_GUARD).toMatch(
      /`request-changes` requires a specific change/,
    );
    expect(EVIDENCE_GUARD).toMatch(/confirm, check, double-check, or verify/);
    expect(EVIDENCE_GUARD).toMatch(/cannot fix a question/);
  });

  test('refuses confidence — including its own — as evidence', () => {
    expect(EVIDENCE_GUARD).toMatch(/Confidence is not evidence/);
    expect(EVIDENCE_GUARD).toMatch(/yourself in an earlier review/);
  });

  test('reaches the skill path too, auto-approve or not', () => {
    for (const autoApprove of [true, false]) {
      expect(
        buildSkillSystemPrompt('some-skill', 'isolated', null, autoApprove),
      ).toContain(EVIDENCE_GUARD);
    }
  });
});

describe('context prompts bound what the reviewer may claim', () => {
  test('isolated: code past the hunk edge is unseen, never a blocker alone', () => {
    const p = CONTEXT_PROMPT.isolated;
    expect(p).toMatch(/stops at the\s+edge of each hunk/);
    expect(p).toMatch(/call site below the last context line/);
    expect(p).toMatch(/may never carry a blocking finding on its own/);
  });

  test('checkout: verify by reading the file instead of asking the author', () => {
    const p = CONTEXT_PROMPT.checkout;
    expect(p).toMatch(/OPEN THE FILE and confirm/);
    expect(p).toMatch(/Never ask the author to confirm something the checkout/);
  });
});

describe('scrutiny prompts', () => {
  test('every tier bars blocking on a question', async () => {
    for (const tier of ['light', 'standard', 'strict'] as const) {
      const text = await readFile(
        join(import.meta.dir, '..', 'src', 'review', 'prompts', `${tier}.md`),
        'utf8',
      );
      expect(text).toMatch(/name the change the author has to make/);
      expect(text).toMatch(/never block a pull request on a question/i);
      expect(text).toMatch(/that is a question, not a blocker/);
    }
  });
});
