import { describe, expect, test } from 'bun:test';
import { PROCESS_GUARD, stripSkillMetaPreamble } from '../src/review/format.ts';
import { buildSkillSystemPrompt } from '../src/review/runner.ts';

// Regression suite for the queue-88705 leak: a worker without the
// configured skill installed posted a review opening with
// "(/bmad-code-review isn't installed here, so this is a manual
// strict-pass review of the diff.)". Two layers: the prompt forbids
// process talk (PROCESS_GUARD), and stripSkillMetaPreamble scrubs the
// known leak shape if the model emits it anyway.

const SKILL = 'bmad-code-review';
const REVIEW =
  'Approving this. The fix actually addresses the rejection instead of\n' +
  'papering over it.\n\nFirst: there is no timeout on the `connecting` state.';

describe('stripSkillMetaPreamble', () => {
  test('strips the observed leak: skill-not-installed preamble', () => {
    const leak = `(/${SKILL} isn't installed here, so this is a manual strict-pass review of the diff.)`;
    const { body, stripped } = stripSkillMetaPreamble(`${leak}\n\n${REVIEW}`, SKILL);
    expect(stripped).toBe(leak);
    expect(body).toBe(REVIEW);
  });

  test('strips "not available, falling back" phrasing too', () => {
    const leak = `Note: the ${SKILL} skill is not available in this environment, falling back to a direct review.`;
    const { body, stripped } = stripSkillMetaPreamble(`${leak}\n\n${REVIEW}`, SKILL);
    expect(stripped).toBe(leak);
    expect(body).toBe(REVIEW);
  });

  test('skill-name match is case-insensitive', () => {
    const leak = `/BMAD-Code-Review isn't installed, so this is a manual review.`;
    const { stripped } = stripSkillMetaPreamble(`${leak}\n\n${REVIEW}`, SKILL);
    expect(stripped).toBe(leak);
  });

  test('leaves a review alone when the first paragraph never names the skill', () => {
    const input = `This wasn't installed correctly in CI — the package is missing.\n\n${REVIEW}`;
    const { body, stripped } = stripSkillMetaPreamble(input, SKILL);
    expect(stripped).toBeNull();
    expect(body).toBe(input);
  });

  test('leaves a legit review that mentions the skill name without availability talk', () => {
    // arbiter reviews its own repo, where findings genuinely discuss the
    // skill by name. Naming it is not enough — only availability/fallback
    // meta-commentary gets stripped.
    const input = `The new ${SKILL} wrapper prompt looks right, one issue below.\n\n${REVIEW}`;
    const { body, stripped } = stripSkillMetaPreamble(input, SKILL);
    expect(stripped).toBeNull();
    expect(body).toBe(input);
  });

  test('never strips when the whole body is one paragraph', () => {
    const input = `/${SKILL} isn't installed here, so this is a manual review. Approving.`;
    const { body, stripped } = stripSkillMetaPreamble(input, SKILL);
    expect(stripped).toBeNull();
    expect(body).toBe(input);
  });

  test('tolerates leading whitespace before the leak paragraph', () => {
    const leak = `(/${SKILL} isn't installed here, so this is a manual review.)`;
    const { body, stripped } = stripSkillMetaPreamble(`\n\n${leak}\n\n${REVIEW}`, SKILL);
    expect(stripped).toBe(leak);
    expect(body).toBe(REVIEW);
  });
});

describe('PROCESS_GUARD in prompts', () => {
  test('skill wrapper prompt forbids process talk and pre-answers the missing-skill case', () => {
    const prompt = buildSkillSystemPrompt(SKILL, 'isolated');
    expect(prompt).toContain(PROCESS_GUARD);
    // The fallback line must name the skill so the instruction binds to
    // the exact thing the model would otherwise narrate about.
    expect(prompt).toMatch(/not installed or fails to load/);
    expect(prompt).toContain(`never mention the skill or`);
  });

  test('guard bans the specific framings that leaked', () => {
    expect(PROCESS_GUARD).toMatch(/posted verbatim/i);
    expect(PROCESS_GUARD).toMatch(/skills or slash commands/i);
    expect(PROCESS_GUARD).toMatch(/silently perform a review/i);
  });
});
