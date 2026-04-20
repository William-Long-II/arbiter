import type { Octokit } from "./client";
import type { LineComment, ReviewResult } from "../review/schema";

export type PostReviewInput = {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  selfLogin: string;
  review: ReviewResult;
};

export type PostReviewOutcome =
  | { status: "posted"; reviewId: number; includedComments: number }
  | { status: "posted-summary-only"; reviewId: number; reason: string }
  | { status: "skipped"; reason: string };

/**
 * Skip re-posting when the machine-user has already reviewed this exact
 * head SHA. Uses the REST listReviews endpoint (paginated).
 */
export async function hasExistingReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
  selfLogin: string,
): Promise<boolean> {
  for await (const page of octokit.paginate.iterator(
    octokit.pulls.listReviews,
    { owner, repo, pull_number: pullNumber, per_page: 100 },
  )) {
    for (const r of page.data) {
      if (r.user?.login === selfLogin && r.commit_id === headSha) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Has the machine-user reviewed this PR on any prior commit? Used to decide
 * whether a new CI-green event is a "first review" or a "re-review" for
 * purposes of the label-or-mention gate.
 */
export async function hasAnyPriorReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  selfLogin: string,
): Promise<boolean> {
  for await (const page of octokit.paginate.iterator(
    octokit.pulls.listReviews,
    { owner, repo, pull_number: pullNumber, per_page: 100 },
  )) {
    for (const r of page.data) {
      if (r.user?.login === selfLogin) return true;
    }
  }
  return false;
}

export async function pullRequestHasLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  labelName: string,
): Promise<boolean> {
  const res = await octokit.issues.listLabelsOnIssue({
    owner,
    repo,
    issue_number: pullNumber,
    per_page: 100,
  });
  return res.data.some((l) => l.name === labelName);
}

/**
 * Remove a label from a PR. No-ops silently if the label is not on the PR
 * (GitHub returns 404 in that case, which we ignore).
 */
export async function removeLabelIfPresent(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  labelName: string,
): Promise<void> {
  try {
    await octokit.issues.removeLabel({
      owner,
      repo,
      issue_number: pullNumber,
      name: labelName,
    });
  } catch (err) {
    const status = (err as { status?: number } | undefined)?.status;
    if (status === 404) return;
    throw err;
  }
}

function toApiComments(
  comments: LineComment[],
): Array<{ path: string; line: number; side: "RIGHT"; body: string }> {
  return comments.map((c) => ({
    path: c.path,
    line: c.line,
    side: "RIGHT",
    body: c.body,
  }));
}

/**
 * Post a review on a PR. Never uses REQUEST_CHANGES — the bot guides, it does
 * not block. Falls back to a summary-only COMMENT review if the original
 * submission fails (most commonly: a line comment targets a line not present
 * in the diff, which makes the whole review 422).
 */
export async function postReview(
  octokit: Octokit,
  input: PostReviewInput,
): Promise<PostReviewOutcome> {
  const { owner, repo, pullNumber, headSha, selfLogin, review } = input;

  if (
    await hasExistingReview(octokit, owner, repo, pullNumber, headSha, selfLogin)
  ) {
    return { status: "skipped", reason: "already reviewed this head SHA" };
  }

  const event = review.verdict === "approve" ? "APPROVE" : "COMMENT";

  try {
    const res = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: headSha,
      event,
      body: review.summary,
      comments: toApiComments(review.lineComments),
    });
    return {
      status: "posted",
      reviewId: res.data.id,
      includedComments: review.lineComments.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (review.lineComments.length === 0) throw err;

    const bodyWithNote =
      `${review.summary}\n\n` +
      `_Note: inline comments were generated but could not be anchored to the diff (${msg}). ` +
      `They have been dropped from this review._`;
    const res = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: headSha,
      event,
      body: bodyWithNote,
    });
    return {
      status: "posted-summary-only",
      reviewId: res.data.id,
      reason: msg,
    };
  }
}

export async function fetchAuthenticatedLogin(octokit: Octokit): Promise<string> {
  const res = await octokit.users.getAuthenticated();
  return res.data.login;
}
