import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  parsePullRequestEvent,
  verifyGithubSignature,
} from '../src/github/webhook.ts';

const SECRET = 'whsec-test';
function sign(body: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyGithubSignature', () => {
  const body = '{"hello":"world"}';

  test('accepts a correct signature (independent HMAC impl agrees)', async () => {
    expect(await verifyGithubSignature(SECRET, body, sign(body))).toBe(true);
  });

  test('rejects wrong secret, tampered body, bad/missing header', async () => {
    expect(await verifyGithubSignature(SECRET, body, sign(body, 'other'))).toBe(false);
    expect(await verifyGithubSignature(SECRET, body + ' ', sign(body))).toBe(false);
    expect(await verifyGithubSignature(SECRET, body, 'deadbeef')).toBe(false);
    expect(await verifyGithubSignature(SECRET, body, null)).toBe(false);
    expect(await verifyGithubSignature('', body, sign(body, ''))).toBe(false);
  });
});

describe('parsePullRequestEvent', () => {
  const base = {
    action: 'opened',
    number: 42,
    repository: { full_name: 'acme/widget' },
    pull_request: {
      title: 'Add thing',
      user: { login: 'octocat' },
      base: { ref: 'main' },
      head: { ref: 'feature/x', sha: 'abc123' },
      draft: false,
      auto_merge: null,
    },
  };

  test('normalizes a relevant event to PRDetails', () => {
    const r = parsePullRequestEvent('pull_request', base);
    expect(r).not.toBeNull();
    expect(r!.action).toBe('opened');
    expect(r!.pr).toEqual({
      repoFull: 'acme/widget',
      number: 42,
      title: 'Add thing',
      author: 'octocat',
      baseBranch: 'main',
      headBranch: 'feature/x',
      headSha: 'abc123',
      draft: false,
      autoMerge: false,
    });
  });

  test('all relevant actions pass; irrelevant ones are ignored', () => {
    for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review', 'review_requested']) {
      expect(parsePullRequestEvent('pull_request', { ...base, action })).not.toBeNull();
    }
    for (const action of ['edited', 'closed', 'labeled', 'assigned', 'review_request_removed']) {
      expect(parsePullRequestEvent('pull_request', { ...base, action })).toBeNull();
    }
  });

  test('extracts requested reviewers (lowercased) and team slugs', () => {
    const r = parsePullRequestEvent('pull_request', {
      ...base,
      action: 'review_requested',
      pull_request: {
        ...base.pull_request,
        requested_reviewers: [
          { login: 'William-Long-II' },
          { login: 'brannon' },
          { nope: true },
        ],
        requested_teams: [{ slug: 'platform-team' }, {}],
      },
    });
    expect(r!.requestedReviewers).toEqual(['william-long-ii', 'brannon']);
    expect(r!.requestedTeams).toEqual(['platform-team']);
  });

  test('missing reviewer/team lists default to empty arrays', () => {
    const r = parsePullRequestEvent('pull_request', base);
    expect(r!.requestedReviewers).toEqual([]);
    expect(r!.requestedTeams).toEqual([]);
  });

  test('non-PR events and non-objects are ignored', () => {
    expect(parsePullRequestEvent('issues', base)).toBeNull();
    expect(parsePullRequestEvent('pull_request', null)).toBeNull();
    expect(parsePullRequestEvent(undefined, base)).toBeNull();
  });

  test('draft PRs are skipped', () => {
    const draft = { ...base, pull_request: { ...base.pull_request, draft: true } };
    expect(parsePullRequestEvent('pull_request', draft)).toBeNull();
  });

  test('auto_merge present ⇒ autoMerge true', () => {
    const am = {
      ...base,
      pull_request: { ...base.pull_request, auto_merge: { enabled_by: { login: 'x' } } },
    };
    expect(parsePullRequestEvent('pull_request', am)!.pr.autoMerge).toBe(true);
  });

  test('missing required fields ⇒ null', () => {
    expect(
      parsePullRequestEvent('pull_request', { ...base, repository: {} }),
    ).toBeNull();
    expect(
      parsePullRequestEvent('pull_request', {
        ...base,
        pull_request: { ...base.pull_request, head: { ref: 'x' } }, // no sha
      }),
    ).toBeNull();
    expect(
      parsePullRequestEvent('pull_request', { ...base, number: 0 }),
    ).toBeNull();
  });
});
