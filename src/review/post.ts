import type { GH } from "../github/client.ts";
import type { RepoRef } from "../github/discover.ts";
import type { ValidatedReview } from "./validate.ts";

export type PostArgs = {
  gh: GH;
  repo: RepoRef;
  pullNumber: number;
  headSha: string;
  review: ValidatedReview;
  dryRun: boolean;
};

export type PostResult =
  | { ok: true; dryRun: true }
  | { ok: true; dryRun: false; reviewId: number; url: string }
  | { ok: false; error: string };

export async function postReview(args: PostArgs): Promise<PostResult> {
  const { gh, repo, pullNumber, headSha, review } = args;

  if (args.dryRun) {
    return { ok: true, dryRun: true };
  }

  const event = review.verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES";

  const comments = review.valid.map((c) => ({
    path: c.path,
    line: c.line,
    side: c.side,
    body: formatBody(c),
  }));

  try {
    const res = await gh.pulls.createReview({
      owner: repo.owner,
      repo: repo.name,
      pull_number: pullNumber,
      commit_id: headSha,
      event,
      body: review.summary,
      comments,
    });
    return {
      ok: true,
      dryRun: false,
      reviewId: res.data.id,
      url: res.data.html_url,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function formatBody(c: { body: string; severity: string }): string {
  const tag = c.severity === "nit" ? "nit" : c.severity;
  return `**${tag}**: ${c.body}`;
}
