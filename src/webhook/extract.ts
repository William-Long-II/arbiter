/**
 * Extract the fields the review loop needs from a parsed GitHub webhook
 * payload. Supported events (Sprint 5 scope):
 *
 *  - `pull_request`  action in {opened, synchronize, reopened}  → queue for review
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
  | { kind: "ignored"; reason: string };

const PULL_REQUEST_ACTIONS = new Set(["opened", "synchronize", "reopened"]);

export function extractWebhookTarget(args: {
  event: string | null;
  payload: unknown;
}): WebhookTarget {
  const { event, payload } = args;

  if (!event) return { kind: "ignored", reason: "missing X-GitHub-Event header" };
  if (event === "ping") return { kind: "ignored", reason: "ping event" };
  if (event !== "pull_request") {
    return { kind: "ignored", reason: `unsupported event: ${event}` };
  }

  if (!isObj(payload)) return { kind: "ignored", reason: "payload is not an object" };

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

  const repo = payload.repository;
  if (!isObj(repo)) return { kind: "ignored", reason: "repository missing" };
  const owner = isObj(repo.owner) ? repo.owner.login : undefined;
  const name = repo.name;
  if (typeof owner !== "string" || !owner) {
    return { kind: "ignored", reason: "repository.owner.login invalid" };
  }
  if (typeof name !== "string" || !name) {
    return { kind: "ignored", reason: "repository.name invalid" };
  }

  return {
    kind: "pull_request",
    action: action as "opened" | "synchronize" | "reopened",
    repo: { owner, name },
    number,
    head_sha: headSha,
  };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
