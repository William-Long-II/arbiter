import { describe, expect, test } from "bun:test";
import { extractWebhookTarget } from "../src/webhook/extract.ts";

function prPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "opened",
    pull_request: { number: 42, head: { sha: "abc123" } },
    repository: { name: "my-repo", owner: { login: "my-org" } },
    ...overrides,
  };
}

describe("extractWebhookTarget", () => {
  test("ping is ignored without error", () => {
    const r = extractWebhookTarget({ event: "ping", payload: {} });
    expect(r.kind).toBe("ignored");
  });

  test("missing event header → ignored", () => {
    const r = extractWebhookTarget({ event: null, payload: prPayload() });
    expect(r.kind).toBe("ignored");
  });

  test("unsupported event (issues, push, etc.) → ignored", () => {
    expect(extractWebhookTarget({ event: "push", payload: {} }).kind).toBe("ignored");
    expect(extractWebhookTarget({ event: "issues", payload: {} }).kind).toBe("ignored");
  });

  test("pull_request opened → targeted", () => {
    const r = extractWebhookTarget({ event: "pull_request", payload: prPayload() });
    expect(r.kind).toBe("pull_request");
    if (r.kind === "pull_request") {
      expect(r.action).toBe("opened");
      expect(r.repo).toEqual({ owner: "my-org", name: "my-repo" });
      expect(r.number).toBe(42);
      expect(r.head_sha).toBe("abc123");
    }
  });

  test("pull_request synchronize and reopened are acted on too", () => {
    for (const action of ["synchronize", "reopened"] as const) {
      const r = extractWebhookTarget({
        event: "pull_request",
        payload: prPayload({ action }),
      });
      expect(r.kind).toBe("pull_request");
    }
  });

  test("pull_request labeled / assigned / closed → ignored (we don't re-review on those)", () => {
    for (const action of ["labeled", "assigned", "closed", "edited"]) {
      const r = extractWebhookTarget({
        event: "pull_request",
        payload: prPayload({ action }),
      });
      expect(r.kind).toBe("ignored");
    }
  });

  test("non-object payload → ignored", () => {
    expect(extractWebhookTarget({ event: "pull_request", payload: null }).kind).toBe("ignored");
    expect(extractWebhookTarget({ event: "pull_request", payload: "string" }).kind).toBe("ignored");
    expect(extractWebhookTarget({ event: "pull_request", payload: [] }).kind).toBe("ignored");
  });

  test("missing pull_request.number → ignored", () => {
    const r = extractWebhookTarget({
      event: "pull_request",
      payload: prPayload({ pull_request: { head: { sha: "abc" } } }),
    });
    expect(r.kind).toBe("ignored");
  });

  test("missing pull_request.head.sha → ignored", () => {
    const r = extractWebhookTarget({
      event: "pull_request",
      payload: prPayload({ pull_request: { number: 5, head: {} } }),
    });
    expect(r.kind).toBe("ignored");
  });

  test("missing repository.owner.login → ignored", () => {
    const r = extractWebhookTarget({
      event: "pull_request",
      payload: prPayload({ repository: { name: "r", owner: {} } }),
    });
    expect(r.kind).toBe("ignored");
  });

  describe("pull_request_review_comment events", () => {
    function commentPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        action: "created",
        comment: {
          in_reply_to_id: 100,
          user: { login: "alice" },
        },
        pull_request: { number: 42 },
        repository: { name: "my-repo", owner: { login: "my-org" } },
        ...overrides,
      };
    }

    test("reply → thread_scan target with comment_author + repo + pr number", () => {
      const r = extractWebhookTarget({
        event: "pull_request_review_comment",
        payload: commentPayload(),
      });
      expect(r.kind).toBe("thread_scan");
      if (r.kind === "thread_scan") {
        expect(r.comment_author).toBe("alice");
        expect(r.repo).toEqual({ owner: "my-org", name: "my-repo" });
        expect(r.number).toBe(42);
      }
    });

    test("action other than created → ignored (edited / deleted don't warrant a sweep)", () => {
      for (const action of ["edited", "deleted", "resolved"]) {
        const r = extractWebhookTarget({
          event: "pull_request_review_comment",
          payload: commentPayload({ action }),
        });
        expect(r.kind).toBe("ignored");
      }
    });

    test("top-level comment (no in_reply_to_id) → ignored (not a thread reply)", () => {
      const r = extractWebhookTarget({
        event: "pull_request_review_comment",
        payload: commentPayload({
          comment: { in_reply_to_id: null, user: { login: "alice" } },
        }),
      });
      expect(r.kind).toBe("ignored");
    });

    test("missing comment user → ignored", () => {
      const r = extractWebhookTarget({
        event: "pull_request_review_comment",
        payload: commentPayload({ comment: { in_reply_to_id: 100 } }),
      });
      expect(r.kind).toBe("ignored");
    });
  });

  describe("check_suite events", () => {
    function checkSuitePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        action: "completed",
        check_suite: {
          conclusion: "success",
          pull_requests: [
            { number: 1, head: { sha: "sha1" } },
            { number: 2, head: { sha: "sha2" } },
          ],
        },
        repository: { name: "my-repo", owner: { login: "my-org" } },
        ...overrides,
      };
    }

    test("completed + success with attached PRs → check_suite_success target", () => {
      const r = extractWebhookTarget({
        event: "check_suite",
        payload: checkSuitePayload(),
      });
      expect(r.kind).toBe("check_suite_success");
      if (r.kind === "check_suite_success") {
        expect(r.repo).toEqual({ owner: "my-org", name: "my-repo" });
        expect(r.pull_requests).toEqual([
          { number: 1, head_sha: "sha1" },
          { number: 2, head_sha: "sha2" },
        ]);
      }
    });

    test("conclusion failure → ignored (we only want now-green signals)", () => {
      for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", null]) {
        const r = extractWebhookTarget({
          event: "check_suite",
          payload: checkSuitePayload({
            check_suite: { conclusion, pull_requests: [] },
          }),
        });
        expect(r.kind).toBe("ignored");
      }
    });

    test("action requested (not completed) → ignored", () => {
      const r = extractWebhookTarget({
        event: "check_suite",
        payload: checkSuitePayload({ action: "requested" }),
      });
      expect(r.kind).toBe("ignored");
    });

    test("no attached pull_requests → ignored (push to a branch with no open PR)", () => {
      const r = extractWebhookTarget({
        event: "check_suite",
        payload: checkSuitePayload({
          check_suite: { conclusion: "success", pull_requests: [] },
        }),
      });
      expect(r.kind).toBe("ignored");
    });

    test("malformed pull_request entries are dropped silently", () => {
      const r = extractWebhookTarget({
        event: "check_suite",
        payload: checkSuitePayload({
          check_suite: {
            conclusion: "success",
            pull_requests: [
              { number: 1, head: { sha: "sha1" } },
              { number: "not-a-number", head: { sha: "sha2" } }, // bad
              { number: 3, head: {} }, // missing sha
              null, // bad
              { number: 4, head: { sha: "sha4" } },
            ],
          },
        }),
      });
      expect(r.kind).toBe("check_suite_success");
      if (r.kind === "check_suite_success") {
        expect(r.pull_requests.map((p) => p.number)).toEqual([1, 4]);
      }
    });
  });
});
