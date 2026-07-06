import { describe, expect, test } from 'bun:test';
import { __internals, type ScopeTarget } from '../src/github/pulls.ts';

const { buildSearchQuery } = __internals;

describe('buildSearchQuery', () => {
  test('always starts with is:pr is:open archived:false', () => {
    expect(buildSearchQuery([])).toBe('is:pr is:open archived:false');
  });

  test('emits org: terms for org targets', () => {
    const targets: ScopeTarget[] = [
      { kind: 'org', target: 'acme' },
      { kind: 'org', target: 'beta' },
    ];
    expect(buildSearchQuery(targets)).toBe(
      'is:pr is:open archived:false org:acme org:beta',
    );
  });

  test('emits repo: terms for repo targets', () => {
    const targets: ScopeTarget[] = [
      { kind: 'repo', target: 'acme/widget' },
      { kind: 'repo', target: 'beta/gadget' },
    ];
    expect(buildSearchQuery(targets)).toBe(
      'is:pr is:open archived:false repo:acme/widget repo:beta/gadget',
    );
  });

  test('mixes org and repo targets', () => {
    const targets: ScopeTarget[] = [
      { kind: 'org', target: 'acme' },
      { kind: 'repo', target: 'other/thing' },
    ];
    expect(buildSearchQuery(targets)).toBe(
      'is:pr is:open archived:false org:acme repo:other/thing',
    );
  });

  test('appends extra terms (e.g. review-requested:@me)', () => {
    const targets: ScopeTarget[] = [{ kind: 'org', target: 'acme' }];
    expect(buildSearchQuery(targets, ['review-requested:@me'])).toBe(
      'is:pr is:open archived:false org:acme review-requested:@me',
    );
  });
});
