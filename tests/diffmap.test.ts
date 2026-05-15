import { describe, expect, test } from 'bun:test';
import {
  commentableLines,
  MAX_INLINE_COMMENTS,
  selectReviewComments,
} from '../src/review/diffmap.ts';
import type { FindingItem } from '../src/review/format.ts';

describe('commentableLines', () => {
  test('numbers RIGHT-side context + added lines; ignores deletions', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-old2',
      '+new2',
      '+new3',
      ' line4',
    ].join('\n');
    const map = commentableLines(diff);
    expect([...map.get('src/a.ts')!].sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);
  });

  test('resets numbering per hunk and keys by file', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '+only',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -10,2 +20,3 @@',
      ' ctx',
      '+addedAt21',
      ' ctx2',
    ].join('\n');
    const map = commentableLines(diff);
    expect([...map.get('src/a.ts')!]).toEqual([1]);
    expect([...map.get('src/b.ts')!].sort((x, y) => x - y)).toEqual([20, 21, 22]);
  });

  test('added file: all + lines; deleted file: nothing (RIGHT is /dev/null)', () => {
    const added = [
      'diff --git a/n.ts b/n.ts',
      '--- /dev/null',
      '+++ b/n.ts',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
    ].join('\n');
    expect([...commentableLines(added).get('n.ts')!]).toEqual([1, 2]);

    const deleted = [
      'diff --git a/d.ts b/d.ts',
      '--- a/d.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-gone1',
      '-gone2',
    ].join('\n');
    expect(commentableLines(deleted).size).toBe(0);
  });

  test('empty / non-diff input yields an empty map', () => {
    expect(commentableLines('').size).toBe(0);
    expect(commentableLines('not a diff at all').size).toBe(0);
  });
});

describe('selectReviewComments', () => {
  const map = new Map<string, Set<number>>([['src/a.ts', new Set([2, 5])]]);
  const item = (over: Partial<FindingItem> = {}): FindingItem => ({
    severity: 'major',
    path: 'src/a.ts',
    line: 2,
    body: 'fix this',
    ...over,
  });

  test('keeps anchored findings, drops the rest', () => {
    const r = selectReviewComments(
      [
        item({ line: 2 }), // ok
        item({ line: 5 }), // ok
        item({ line: 3 }), // not in diff
        item({ path: 'other.ts', line: 2 }), // unknown file
        item({ line: 2, body: '  ' }), // empty body
      ],
      map,
    );
    expect(r.comments).toHaveLength(2);
    expect(r.comments.every((c) => c.side === 'RIGHT')).toBe(true);
    expect(r.dropped).toBe(3);
  });

  test('caps at MAX_INLINE_COMMENTS, overflow counts as dropped', () => {
    const big = new Set<number>();
    for (let i = 1; i <= MAX_INLINE_COMMENTS + 10; i++) big.add(i);
    const items = [...big].map((line) => item({ line }));
    const r = selectReviewComments(items, new Map([['src/a.ts', big]]));
    expect(r.comments).toHaveLength(MAX_INLINE_COMMENTS);
    expect(r.dropped).toBe(10);
  });

  test('non-integer line is dropped', () => {
    const r = selectReviewComments([item({ line: 2.5 })], map);
    expect(r.comments).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });
});
