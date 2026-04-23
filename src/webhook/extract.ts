/**
 * Extract the fields the review loop needs from a parsed GitHub webhook
 * payload. Supported events:
 *
 *  - `pull_request`                 action in {opened, synchronize, reopened}
 *                                   → queue PR for review
 *  - `pull_request_review_comment`  action=created, not authored by the
 *                                   bot → queue PR for a thread-reply sweep
 *  - `check_suite`                  action=completed, conclusion=success,
 *                                   with attached pull_requests → queue each
 *                                   listed PR for review (CI-now-green path)
 *
 * Everything else is classified as "ignored" so the webhook route can
 * return 200 without spending loop cycles on it.
 *
 * Pure function — does no IO. The caller supplies the parsed JSON payload
 * plus the `X-GitHub-Event` header value.
 */
export type WebhookTarget =
  | {
      kind: "pull_request";
      action: "opened" | "synchronize" | "reopened";
      repo: { owner: string; name: string };
      number: number;
      head_sha: string;
    }
  | {
      kind: "thread_scan";
      /** Author of the triggering comment — included so the webhook route
       *  can skip bot self-triggers without re-parsing. */
      comment_author: string;
      repo: { owner: string; name: string };
      number: number;
    }
  | {
      kind: "check_suite_success";
      repo: { owner: string; name: string };
      /** Every PR the check suite attached to. May be empty when the check
       *  suite belongs to a push not associated with an open PR; the
       *  webhook route treats that as "ignored" in practice. */
      pull_requests: Array<{ number: number; head_sha: string }>;
    }
  | { kind: "ignored"; reason: string };

const PULL_REQUEST_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export function extractWebhookTarget(args: {
  event: string | null;
  payload: unknown;
}): WebhookTarget {
  const { event, payload } = args;

  if (!event) return { kind: "ignored", reason: "missing X-GitHub-Event header" };
  if (event === "ping") return { kind: "ignored", reason: "ping event" };
  if (!isObj(payload)) return { kind: "ignored", reason: "payload is not an object" };

  if (event === "pull_request") return extractPullRequest(payload);
  if (event === "pull_request_review_comment") return extractThreadScan(payload);
  if (event === "check_suite") return extractCheckSuite(payload);
  return { kind: "ignored", reason: `unsupported event: ${event}` };
}

function extractPullRequest(payload: Record<string, unknown>): WebhookTarget {
  const action = payload.action;
  if (typeof action !== "string" || !PULL_REQUEST_ACTIONS.has(action)) {
    return { kind: "ignored", reason: `pull_request action not acted on: ${action ?? "(missing)"}` };
  }

  const pr = payload.pull_request;
  if (!isObj(pr)) return { kind: "ignored", reason: "pull_request object missing" };
  const number = pr.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
    return { kind: "ignored", reason: "pull_request.number invalid" };
  }

  const head = pr.head;
  if (!isObj(head)) return { kind: "ignored", reason: "pull_request.head missing" };
  const headSha = head.sha;
  if (typeof headSha !== "string" || headSha.length === 0) {
    return { kind: "ignored", reason: "pull_request.head.sha invalid" };
  }

  const repoSlug = extractRepo(payload);
  if (!repoSlug) return { kind: "ignored", reason: "repository missing" };

  return {
    kind: "pull_request",
    action: action as "opened" | "synchronize" | "reopened",
    repo: repoSlug,
    number,
    head_sha: headSha,
  };
}

function extractThreadScan(payload: Record<string, unknown>): WebhookTarget {
  // GitHub only fires this event with action "created" / "edited" / "deleted".
  // We only act on `created` — "edited" doesn't signal a new reply needing
  // a response; "deleted" removes a reply that may have been the one
  // awaiting us, but the next tick will notice and do nothing gracefully.
  if (payload.action !== "created") {
    return { kind: "ignored", reason: `review_comment action not acted on: ${String(payload.action ?? "(missing)")}` };
  }

  const comment = payload.comment;
  if (!isObj(comment)) return { kind: "ignored", reason: "comment object missing" };
  // A thread reply has in_reply_to_id; a top-level file comment doesn't.
  // We only iterate on replies to existing threads (the bot's own line
  // comments are always top-level, so in_reply_to_id being present means
  // "someone replied to an existing thread", which is what #136's sweep
  // acts on).
  if (comment.in_reply_to_id === null || comment.in_reply_to_id === undefined) {
    return { kind: "ignored", reason: "top-level review comment (not a reply)" };
  }
  const commentAuthor = isObj(comment.user) && typeof comment.user.login === "string"
    ? comment.user.login
    : "";
  if (!commentAuthor) {
    return { kind: "ignored", reason: "comment.user.login invalid" };
  }

  const pr = payload.pull_request;
  if (!isObj(pr)) return { kind: "ignored", reason: "pull_request object missing" };
  const number = pr.number;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
    return { kind: "ignored", reason: "pull_request.number invalid" };
  }

  const repoSlug = extractRepo(payload);
  if (!repoSlug) return { kind: "ignored", reason: "repository missing" };

  return {
    kind: "thread_scan",
    comment_author: commentAuthor,
    repo: repoSlug,
    number,
  };
}

function extractCheckSuite(payload: Record<string, unknown>): WebhookTarget {
  if (payload.action !== "completed") {
    return { kind: "ignored", reason: `check_suite action not acted on: ${String(payload.action ?? "(missing)")}` };
  }
  const suite = payload.check_suite;
  if (!isObj(suite)) return { kind: "ignored", reason: "check_suite object missing" };
  if (suite.conclusion !== "success") {
    return { kind: "ignored", reason: `check_suite conclusion not success: ${String(suite.conclusion ?? "(missing)")}` };
  }

  const repoSlug = extractRepo(payload);
  if (!repoSlug) return { kind: "ignored", reason: "repository missing" };

  // pull_requests[] is the GitHub-provided list of PRs this check suite
  // attached to. Can be empty — e.g., a push to a branch with no open PR
  // fires check_suite but has nothing for us to act on.
  const prs = Array.isArray(suite.pull_requests) ? suite.pull_requests : [];
  const pull_requests: Array<{ number: number; head_sha: string }> = [];
  for (const p of prs) {
    if (!isObj(p)) continue;
    const number = p.number;
    const head = isObj(p.head) ? p.head : null;
    const headSha = head && typeof head.sha === "string" ? head.sha : "";
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) continue;
    if (!headSha) continue;
    pull_requests.push({ number, head_sha: headSha });
  }

  if (pull_requests.length === 0) {
    return { kind: "ignored", reason: "check_suite has no attached pull_requests" };
  }

  return {
    kind: "check_suite_success",
    repo: repoSlug,
    pull_requests,
  };
}

function extractRepo(payload: Record<string, unknown>): { owner: string; name: string } | null {
  const repo = payload.repository;
  if (!isObj(repo)) return null;
  const owner = isObj(repo.owner) ? repo.owner.login : undefined;
  const name = repo.name;
  if (typeof owner !== "string" || !owner) return null;
  if (typeof name !== "string" || !name) return null;
  return { owner, name };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
