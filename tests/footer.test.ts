import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_FOOTER_TEMPLATE,
  renderFooter,
  stampReviewBody,
} from '../src/review/footer.ts';

const ctx = {
  scrutiny: 'standard',
  mode: 'subscription' as const,
  verdict: 'approve' as const,
  postedEvent: 'APPROVE' as const,
};

describe('renderFooter', () => {
  test('null → uses default template + substitutes placeholders', () => {
    const out = renderFooter(null, ctx);
    expect(out).toContain('scrutiny: `standard`');
    expect(out).toContain('mode: `subscription`');
    expect(out).toContain('verdict: `approve`');
    expect(out).toContain('posted as: `APPROVE`');
  });

  test('empty string → no footer (returns null)', () => {
    expect(renderFooter('', ctx)).toBeNull();
  });

  test('custom template substitutes the same placeholders', () => {
    const out = renderFooter('s={{scrutiny}} m={{mode}} v={{verdict}} p={{posted_as}}', ctx);
    expect(out).toBe('s=standard m=subscription v=approve p=APPROVE');
  });

  test('template with no placeholders is returned verbatim', () => {
    expect(renderFooter('just plain text', ctx)).toBe('just plain text');
  });

  test('repeated placeholders all get substituted', () => {
    const out = renderFooter('{{scrutiny}}-{{scrutiny}}-{{scrutiny}}', ctx);
    expect(out).toBe('standard-standard-standard');
  });
});

describe('stampReviewBody', () => {
  test('appends rendered footer separated by ---', () => {
    const out = stampReviewBody('the review body', null, ctx);
    expect(out).toMatch(/the review body\n\n---\n_Reviewed by reviewme/);
  });

  test('no footer when template is empty string', () => {
    expect(stampReviewBody('body', '', ctx)).toBe('body');
  });

  test('custom template appended cleanly', () => {
    const out = stampReviewBody('body', '— {{verdict}}', ctx);
    expect(out).toBe('body\n\n---\n— approve');
  });
});

describe('DEFAULT_FOOTER_TEMPLATE shape', () => {
  test('contains all four placeholders', () => {
    expect(DEFAULT_FOOTER_TEMPLATE).toContain('{{scrutiny}}');
    expect(DEFAULT_FOOTER_TEMPLATE).toContain('{{mode}}');
    expect(DEFAULT_FOOTER_TEMPLATE).toContain('{{verdict}}');
    expect(DEFAULT_FOOTER_TEMPLATE).toContain('{{posted_as}}');
  });
});
