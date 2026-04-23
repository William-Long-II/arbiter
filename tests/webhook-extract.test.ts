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
});
