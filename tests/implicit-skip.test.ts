/**
 * Tests for issue #89 — implicit skip via PR title keywords and branch prefix.
 *
 * Coverage:
 *   1. shouldSkipImplicit — all regex patterns from the spec, case-insensitivity,
 *      boundary conditions (not-at-start, partial-word).
 *   2. Integration via webhook events:
 *      - WIP:-titled PR opened → no runPipeline (implicit-skip metric bumped)
 *      - draft/-branch PR opened → no runPipeline (implicit-skip metric bumped)
 *      - Normal PR opened → no implicit-skip metric bump (regression)
 */

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { buildAllowlist } from "../src/config/repos";
import type { Octokit } from "../src/github";
import { shouldSkipImplicit } from "../src/server/triggers";
import { createWebhooks } from "../src/server/webhooks";
import { registry, implicitSkipTotal } from "../src/server/metrics";

// ---------------------------------------------------------------------------
// Unit tests: shouldSkipImplicit matcher
// ---------------------------------------------------------------------------

describe("shouldSkipImplicit — title patterns", () => {
  // --- Should skip ---

  test("WIP: prefix skips (canonical case)", () => {
    const r = shouldSkipImplicit({ prTitle: "WIP: my feature", branch: "feature/x" });
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toBe("title");
  });

  test("Wip: prefix skips (case-insensitive)", () => {
    const r = shouldSkipImplicit({ prTitle: "Wip: something", branch: "feature/x" });
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toBe("title");
  });

  test("wip: lowercase skips", () => {
    const r = shouldSkipImplicit({ prTitle: "wip: a thing", branch: "feature/x" });
    expect(r.skip).toBe(true);
  });

  test("Draft: prefix skips", () => {
    const r = shouldSkipImplicit({ prTitle: "Draft: my feature", branch: "feature/x" });
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toBe("title");
  });

  test("DRAFT: uppercase skips", () => {
    const r = shouldSkipImplicit({ prTitle: "DRAFT: my feature", branch: "feature/x" });
    expect(r.skip).toBe(true);
  });

  test("RFC: prefix skips", () => {
    const r = shouldSkipImplicit({ prTitle: "RFC: design discussion", branch: "feature/x" });
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toBe("title");
  });

  test("[skip-review] prefix skips", () => {
    const r = shouldSkipImplicit({ prTitle: "[skip-review] not ready", branch: "feature/x" });
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toBe("title");
  });

  test("[SKIP-REVIEW] uppercase prefix skips", () => {
    const r = shouldSkipImplicit({ prTitle: "[SKIP-REVIEW] foo", branch: "feature/x" });
    expect(r.skip).toBe(true);
  });

  test("[skip review] with space skips", () => {
    const r = shouldSkipImplicit({ prTitle: "[skip review] bar", branch: "feature/x" });
    expect(r.skip).toBe(true);
  });

  test("[WIP] bracket prefix skips", () => {
    const r = shouldSkipImplicit({ prTitle: "[WIP] some feature", branch: "feature/x" });
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toBe("title");
  });

  test("[wip] lowercase bracket skips", () => {
    const r = shouldSkipImplicit({ prTitle: "[wip] some feature", branch: "feature/x" });
    expect(r.skip).toBe(true);
  });

  test("[Draft] bracket prefix skips", () => {
    const r = shouldSkipImplicit({ prTitle: "[Draft] spec", branch: "feature/x" });
    expect(r.skip).toBe(true);
  });

  test("bare WIP word at start skips", () => {
    const r = shouldSkipImplicit({ prTitle: "WIP my feature", branch: "feature/x" });
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toBe("title");
  });

  test("bare draft word at start skips", () => {
    const r = shouldSkipImplicit({ prTitle: "draft fix for the thing", branch: "feature/x" });
    expect(r.skip).toBe(true);
  });

  // Leading/trailing whitespace is trimmed before matching
  test("WIP: with leading whitespace in title still skips", () => {
    const r = shouldSkipImplicit({ prTitle: "  WIP: padded title", branch: "feature/x" });
    expect(r.skip).toBe(true);
  });

  // --- Should NOT skip ---

  test("foo WIP does NOT skip (WIP not at start)", () => {
    const r = shouldSkipImplicit({ prTitle: "foo WIP", branch: "feature/x" });
    expect(r.skip).toBe(false);
  });

  test("Add WIP feature does NOT skip (WIP mid-title)", () => {
    const r = shouldSkipImplicit({ prTitle: "Add WIP feature", branch: "feature/x" });
    expect(r.skip).toBe(false);
  });

  test("empty title does NOT skip", () => {
    const r = shouldSkipImplicit({ prTitle: "", branch: "feature/x" });
    expect(r.skip).toBe(false);
  });

  test("whitespace-only title does NOT skip", () => {
    const r = shouldSkipImplicit({ prTitle: "   ", branch: "feature/x" });
    expect(r.skip).toBe(false);
  });

  test("normal title does NOT skip", () => {
    const r = shouldSkipImplicit({ prTitle: "Add login button", branch: "feature/auth" });
    expect(r.skip).toBe(false);
  });

  test("title containing wip later does NOT skip", () => {
    const r = shouldSkipImplicit({ prTitle: "Fix: handle edge case (wip)", branch: "feature/x" });
    expect(r.skip).toBe(false);
  });
});

describe("shouldSkipImplicit — branch patterns", () => {
  // --- Should skip ---

  test("draft/ branch prefix skips", () => {
    const r = shouldSkipImplicit({ prTitle: "Normal title", branch: "draft/x" });
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toBe("branch");
  });

  test("wip/ branch prefix skips", () => {
    const r = shouldSkipImplicit({ prTitle: "Normal title", branch: "wip/my-thing" });
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toBe("branch");
  });

  test("WIP/ uppercase branch prefix skips (case-insensitive)", () => {
    const r = shouldSkipImplicit({ prTitle: "Normal title", branch: "WIP/feature" });
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toBe("branch");
  });

  test("Draft/ mixed-case branch prefix skips", () => {
    const r = shouldSkipImplicit({ prTitle: "Normal title", branch: "Draft/my-feature" });
    expect(r.skip).toBe(true);
  });

  // --- Should NOT skip ---

  test("feature/ branch does NOT skip", () => {
    const r = shouldSkipImplicit({ prTitle: "Normal title", branch: "feature/x" });
    expect(r.skip).toBe(false);
  });

  test("main branch does NOT skip", () => {
    const r = shouldSkipImplicit({ prTitle: "Normal title", branch: "main" });
    expect(r.skip).toBe(false);
  });

  test("empty branch does NOT skip", () => {
    const r = shouldSkipImplicit({ prTitle: "Normal title", branch: "" });
    expect(r.skip).toBe(false);
  });

  test("branch containing wip not at start does NOT skip", () => {
    const r = shouldSkipImplicit({ prTitle: "Normal title", branch: "feature/wip-something" });
    expect(r.skip).toBe(false);
  });
});

describe("shouldSkipImplicit — title takes precedence over branch", () => {
  test("matching title returns reason=title even when branch also matches", () => {
    const r = shouldSkipImplicit({ prTitle: "WIP: thing", branch: "wip/thing" });
    expect(r.skip).toBe(true);
    if (r.skip) expect(r.reason).toBe("title");
  });
});

// ---------------------------------------------------------------------------
// Integration tests: webhook events → implicit-skip metric
// ---------------------------------------------------------------------------

const SECRET = "implicit-skip-test-secret";

function sign(payload: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

/** Read the current value of reviewme_implicit_skip_total{reason} from the registry. */
function readImplicitSkipCount(reason: "title" | "branch"): number {
  const text = registry.render();
  // Matches: reviewme_implicit_skip_total{reason="title"} 5
  const re = new RegExp(`reviewme_implicit_skip_total\\{reason="${reason}"\\}\\s+(\\d+)`, "m");
  const match = text.match(re);
  return match ? parseInt(match[1]!, 10) : 0;
}

function makeAllowlist() {
  return buildAllowlist({
    "acme/widget": {
      enabled: true,
      rereview: "auto-on-sync",
      rereview_label: "re-review",
    },
  });
}

/** Fire a webhook event directly via webhooks.verifyAndReceive. */
async function fireEvent(
  webhooks: ReturnType<typeof createWebhooks>,
  eventName: string,
  payload: unknown,
  id = "00000000-0000-0000-0000-000000000099",
): Promise<void> {
  const body = JSON.stringify(payload);
  await webhooks.verifyAndReceive({
    id,
    name: eventName as Parameters<typeof webhooks.verifyAndReceive>[0]["name"],
    signature: sign(body),
    payload: body,
  });
}

/** Minimal octokit that returns green CI and no prior reviews. */
function makeOctokit(): Octokit {
  return {
    checks: {
      listForRef: async () => ({
        data: {
          check_runs: [{ status: "completed", conclusion: "success", name: "CI" }],
        },
      }),
    },
    pulls: {
      listReviews: async () => ({ data: [] }),
      get: async () => ({
        data: {
          title: "Normal PR title",
          body: "",
          draft: false,
          head: { sha: "abc123", ref: "feature/my-thing" },
        },
      }),
      listReviewComments: async () => ({ data: [] }),
    },
  } as unknown as Octokit;
}

const noopAnthropic = {} as Anthropic;

describe("implicit-skip integration via ready_for_review webhook", () => {
  function makeReadyPayload(title: string, branch: string) {
    return {
      action: "ready_for_review",
      number: 77,
      pull_request: {
        number: 77,
        draft: false,
        title,
        head: { sha: "cafebabe", ref: branch },
      },
      repository: {
        full_name: "acme/widget",
        owner: { login: "acme" },
        name: "widget",
      },
      sender: { login: "dev" },
    };
  }

  test("WIP:-titled PR → implicit-skip metric bumped (title)", async () => {
    const before = readImplicitSkipCount("title");

    const webhooks = createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: makeOctokit(),
      anthropic: noopAnthropic,
      selfLogin: "review-me-bot",
    });

    await fireEvent(
      webhooks,
      "pull_request",
      makeReadyPayload("WIP: not done yet", "feature/my-thing"),
      "id-implicit-title-1",
    );

    const after = readImplicitSkipCount("title");
    expect(after - before).toBe(1);
  });

  test("draft/-branch PR → implicit-skip metric bumped (branch)", async () => {
    const before = readImplicitSkipCount("branch");

    const webhooks = createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: makeOctokit(),
      anthropic: noopAnthropic,
      selfLogin: "review-me-bot",
    });

    await fireEvent(
      webhooks,
      "pull_request",
      makeReadyPayload("Some feature", "draft/exploratory"),
      "id-implicit-branch-1",
    );

    const after = readImplicitSkipCount("branch");
    expect(after - before).toBe(1);
  });

  test("normal PR → NO implicit-skip metric bump (regression)", async () => {
    const beforeTitle = readImplicitSkipCount("title");
    const beforeBranch = readImplicitSkipCount("branch");

    const webhooks = createWebhooks(SECRET, {
      getAllowlist: makeAllowlist,
      octokit: makeOctokit(),
      anthropic: noopAnthropic,
      selfLogin: "review-me-bot",
    });

    await fireEvent(
      webhooks,
      "pull_request",
      makeReadyPayload("Add login button", "feature/auth"),
      "id-normal-pr-regression-1",
    );

    const afterTitle = readImplicitSkipCount("title");
    const afterBranch = readImplicitSkipCount("branch");
    expect(afterTitle - beforeTitle).toBe(0);
    expect(afterBranch - beforeBranch).toBe(0);
  });
});
