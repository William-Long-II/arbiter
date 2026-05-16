import { describe, expect, test } from 'bun:test';
import { ITEMS_INSTRUCTION, parseFindingItems } from '../src/review/format.ts';

const block = (json: string) =>
  `Review prose here.\n\n<!-- arbiter:items -->\n\`\`\`json\n${json}\n\`\`\`\n`;

describe('parseFindingItems', () => {
  test('parses a valid block and strips it from the body', () => {
    const r = parseFindingItems(
      block(
        '[{"severity":"blocking","path":"src/x.ts","line":42,"body":"bug"}]',
      ),
    );
    expect(r.items).toEqual([
      { severity: 'blocking', path: 'src/x.ts', line: 42, body: 'bug' },
    ]);
    expect(r.body).toBe('Review prose here.');
  });

  test('absent block ⇒ [] and body untouched', () => {
    const body = '## Issues\n- just prose, no items block';
    const r = parseFindingItems(body);
    expect(r.items).toEqual([]);
    expect(r.body).toBe(body);
  });

  test('malformed JSON ⇒ [] but the block is still stripped', () => {
    const r = parseFindingItems(block('[not json'));
    expect(r.items).toEqual([]);
    expect(r.body).toBe('Review prose here.');
  });

  test('invalid entries are dropped, valid ones kept; line floored', () => {
    const r = parseFindingItems(
      block(
        JSON.stringify([
          { severity: 'nit', path: 'a.ts', line: 3.9, body: 'x' }, // floor → 3
          { severity: 'bogus', path: 'a.ts', line: 1, body: 'x' }, // bad severity
          { severity: 'major', path: '', line: 1, body: 'x' }, // empty path
          { severity: 'minor', path: 'b.ts', line: 0, body: 'x' }, // line ≤ 0
          { severity: 'minor', path: 'b.ts', line: 2, body: '   ' }, // empty body
          { severity: 'blocking', path: 'c.ts', line: 9, body: 'ok' }, // valid
        ]),
      ),
    );
    expect(r.items).toEqual([
      { severity: 'nit', path: 'a.ts', line: 3, body: 'x' },
      { severity: 'blocking', path: 'c.ts', line: 9, body: 'ok' },
    ]);
  });

  test('non-array JSON ⇒ []', () => {
    expect(parseFindingItems(block('{"severity":"nit"}')).items).toEqual([]);
  });

  test('tolerates a plain (non-json-tagged) fence', () => {
    const r = parseFindingItems(
      'x\n<!-- arbiter:items -->\n```\n[{"severity":"nit","path":"a","line":1,"body":"b"}]\n```',
    );
    expect(r.items).toHaveLength(1);
  });

  test('ITEMS_INSTRUCTION advertises the marker', () => {
    expect(ITEMS_INSTRUCTION).toContain('arbiter:items');
  });
});
