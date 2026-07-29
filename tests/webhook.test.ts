import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  parseIssueCommentEvent,
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

// Comment-triggered re-review. The deadlock this unblocks: a review that
// posts `request-changes` over a question. Only a push re-ran arbiter, so
// the author could answer correctly and nothing would ever read it — the
// block stood until they pushed a commit they didn't need.
describe('parseIssueCommentEvent', () => {
  const base = {
    action: 'created',
    repository: { full_name: 'acme/widget' },
    issue: {
      number: 42,
      pull_request: { url: 'https://api.github.com/…/pulls/42' },
      user: { login: 'octocat' },
      state: 'open',
    },
    comment: {
      body: 'Line 485 already reads `dbQueryParams`.',
      user: { login: 'octocat', type: 'User' },
    },
  };

  test('normalizes a PR author reply', () => {
    const r = parseIssueCommentEvent('issue_comment', base);
    expect(r).toEqual({
      repoFull: 'acme/widget',
      prNumber: 42,
      commenter: 'octocat',
      prAuthor: 'octocat',
      body: 'Line 485 already reads `dbQueryParams`.',
    });
  });

  test('only the author unblocks their own PR', () => {
    const other = {
      ...base,
      comment: { ...base.comment, user: { login: 'someone-else', type: 'User' } },
    };
    expect(parseIssueCommentEvent('issue_comment', other)).toBeNull();
    // Login case is GitHub-insensitive; a case difference is the same person.
    const cased = {
      ...base,
      comment: { ...base.comment, user: { login: 'OctoCat', type: 'User' } },
    };
    expect(parseIssueCommentEvent('issue_comment', cased)).not.toBeNull();
  });

  test('bots never trigger — that is how a review loop starts', () => {
    const bot = {
      ...base,
      issue: { ...base.issue, user: { login: 'arbiter[bot]' } },
      comment: { ...base.comment, user: { login: 'arbiter[bot]', type: 'Bot' } },
    };
    expect(parseIssueCommentEvent('issue_comment', bot)).toBeNull();
  });

  test('only newly created comments; an edit must not re-trigger', () => {
    for (const action of ['edited', 'deleted']) {
      expect(
        parseIssueCommentEvent('issue_comment', { ...base, action }),
      ).toBeNull();
    }
  });

  test('plain issues and closed PRs are ignored', () => {
    expect(
      parseIssueCommentEvent('issue_comment', {
        ...base,
        issue: { ...base.issue, pull_request: undefined },
      }),
    ).toBeNull();
    expect(
      parseIssueCommentEvent('issue_comment', {
        ...base,
        issue: { ...base.issue, state: 'closed' },
      }),
    ).toBeNull();
  });

  test('wrong event name, empty body, or missing fields ⇒ null', () => {
    expect(parseIssueCommentEvent('pull_request', base)).toBeNull();
    expect(
      parseIssueCommentEvent('issue_comment', {
        ...base,
        comment: { ...base.comment, body: '   ' },
      }),
    ).toBeNull();
    expect(
      parseIssueCommentEvent('issue_comment', { ...base, repository: {} }),
    ).toBeNull();
    expect(
      parseIssueCommentEvent('issue_comment', {
        ...base,
        issue: { ...base.issue, number: 0 },
      }),
    ).toBeNull();
  });

  test('a pull_request delivery is not mistaken for a comment (and vice versa)', () => {
    expect(parseIssueCommentEvent('issue_comment', { action: 'opened' })).toBeNull();
    expect(parsePullRequestEvent('issue_comment', base)).toBeNull();
  });
});
