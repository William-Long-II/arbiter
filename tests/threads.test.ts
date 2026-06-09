import { describe, expect, test } from 'bun:test';
import {
  selectThreadsToResolve,
  type PRReviewThread,
} from '../src/github/threads.ts';

const thread = (
  id: string,
  commentAuthors: Array<string | null>,
  isResolved = false,
  hasUnfetchedComments = false,
): PRReviewThread => ({ id, isResolved, commentAuthors, hasUnfetchedComments });

describe('selectThreadsToResolve', () => {
  test('keeps unresolved threads authored solely by the reviewer', () => {
    const threads = [
      thread('t1', ['arbiter-bot']),
      thread('t2', ['arbiter-bot', 'arbiter-bot']),
    ];
    expect(selectThreadsToResolve(threads, 'arbiter-bot')).toEqual(['t1', 't2']);
  });

  test('login comparison is case-insensitive', () => {
    expect(
      selectThreadsToResolve([thread('t1', ['Arbiter-Bot'])], 'arbiter-bot'),
    ).toEqual(['t1']);
  });

  test('skips already-resolved threads', () => {
    expect(
      selectThreadsToResolve([thread('t1', ['arbiter-bot'], true)], 'arbiter-bot'),
    ).toEqual([]);
  });

  test('skips threads someone else replied to — not ours to close', () => {
    expect(
      selectThreadsToResolve(
        [thread('t1', ['arbiter-bot', 'human-dev'])],
        'arbiter-bot',
      ),
    ).toEqual([]);
  });

  test('skips threads opened by someone else entirely', () => {
    expect(
      selectThreadsToResolve([thread('t1', ['human-dev'])], 'arbiter-bot'),
    ).toEqual([]);
  });

  test('skips threads with unattributable comments (deleted user / bot)', () => {
    expect(
      selectThreadsToResolve(
        [thread('t1', ['arbiter-bot', null])],
        'arbiter-bot',
      ),
    ).toEqual([]);
  });

  test('skips threads whose author list is truncated — unseen tail could be anyone', () => {
    expect(
      selectThreadsToResolve(
        [thread('t1', ['arbiter-bot', 'arbiter-bot'], false, true)],
        'arbiter-bot',
      ),
    ).toEqual([]);
  });

  test('skips threads with no comments at all', () => {
    expect(selectThreadsToResolve([thread('t1', [])], 'arbiter-bot')).toEqual([]);
  });

  test('empty input yields empty output', () => {
    expect(selectThreadsToResolve([], 'arbiter-bot')).toEqual([]);
  });

  test('mixed bag: only the qualifying thread survives', () => {
    const threads = [
      thread('mine-open', ['arbiter-bot']),
      thread('mine-resolved', ['arbiter-bot'], true),
      thread('mine-with-reply', ['arbiter-bot', 'human-dev']),
      thread('theirs', ['human-dev']),
    ];
    expect(selectThreadsToResolve(threads, 'arbiter-bot')).toEqual(['mine-open']);
  });
});
