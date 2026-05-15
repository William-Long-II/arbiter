import { describe, expect, test } from 'bun:test';
import {
  FINDINGS_INSTRUCTION,
  parseFindings,
  parseVerdict,
  topSeverity,
} from '../src/review/format.ts';

describe('parseFindings', () => {
  test('extracts counts and strips the marker', () => {
    const body =
      '<!-- arbiter:findings={"blocking":1,"major":0,"minor":2,"nit":3} -->\n\n## Issues\n- x';
    const r = parseFindings(body);
    expect(r.findings).toEqual({ blocking: 1, major: 0, minor: 2, nit: 3 });
    expect(r.body).toBe('## Issues\n- x');
  });

  test('absent marker ⇒ null, body untouched', () => {
    const body = '## Issues\n- nothing machine-readable here';
    const r = parseFindings(body);
    expect(r.findings).toBeNull();
    expect(r.body).toBe(body);
  });

  test('missing keys default to 0', () => {
    expect(parseFindings('<!-- arbiter:findings={"blocking":2} -->').findings).toEqual(
      { blocking: 2, major: 0, minor: 0, nit: 0 },
    );
  });

  test('negative / fractional / non-numeric coerce to 0 or floor', () => {
    const r = parseFindings(
      '<!-- arbiter:findings={"blocking":-4,"major":1.9,"minor":"x","nit":3} -->',
    );
    expect(r.findings).toEqual({ blocking: 0, major: 1, minor: 0, nit: 3 });
  });

  test('malformed JSON ⇒ null, body untouched', () => {
    const body = '<!-- arbiter:findings={not json} -->\nreview';
    const r = parseFindings(body);
    expect(r.findings).toBeNull();
    expect(r.body).toBe(body);
  });

  test('tolerates whitespace in the marker', () => {
    expect(
      parseFindings('<!--   arbiter:findings={"blocking":0,"major":0,"minor":0,"nit":1}   -->')
        .findings,
    ).toEqual({ blocking: 0, major: 0, minor: 0, nit: 1 });
  });

  test('verdict then findings (runner order) leaves a clean body', () => {
    const raw =
      '<!-- arbiter:verdict=request-changes -->\n' +
      '<!-- arbiter:findings={"blocking":1,"major":0,"minor":0,"nit":0} -->\n' +
      'Real review text.';
    const v = parseVerdict(raw);
    const f = parseFindings(v.body);
    expect(v.verdict).toBe('request-changes');
    expect(f.findings).toEqual({ blocking: 1, major: 0, minor: 0, nit: 0 });
    expect(f.body).toBe('Real review text.');
  });
});

describe('topSeverity', () => {
  test('returns the highest non-zero severity by precedence', () => {
    expect(topSeverity({ blocking: 0, major: 0, minor: 0, nit: 5 })).toBe('nit');
    expect(topSeverity({ blocking: 0, major: 0, minor: 2, nit: 5 })).toBe('minor');
    expect(topSeverity({ blocking: 0, major: 1, minor: 2, nit: 5 })).toBe('major');
    expect(topSeverity({ blocking: 3, major: 1, minor: 2, nit: 5 })).toBe('blocking');
  });

  test('all-zero ⇒ null; null/undefined ⇒ null', () => {
    expect(topSeverity({ blocking: 0, major: 0, minor: 0, nit: 0 })).toBeNull();
    expect(topSeverity(null)).toBeNull();
    expect(topSeverity(undefined)).toBeNull();
  });
});

test('FINDINGS_INSTRUCTION advertises the exact marker key', () => {
  expect(FINDINGS_INSTRUCTION).toContain('arbiter:findings=');
  expect(FINDINGS_INSTRUCTION.length).toBeGreaterThan(0);
});
