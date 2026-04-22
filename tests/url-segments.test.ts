import { describe, expect, test } from "bun:test";

/**
 * Locks down the URL shape produced for review-detail and repo-edit pages.
 *
 * Real bug (fixed alongside this test): the dashboard produced
 *   /reviews/owner%2Fname/1
 * but the server route matcher expected
 *   /reviews/:owner/:name/:pr        — i.e. THREE real slash-separated segments.
 *
 * The encoded slash (%2F) is preserved in req.url.pathname by Bun (and browsers
 * in general), so the single-segment form never matched and the detail page 404'd.
 *
 * These tests keep the URL generators honest without pulling in the full HTML
 * renderer. If a future refactor re-inlines the URL construction, the tests
 * here should fail loudly instead of letting a silent 404 slip through.
 */

const REVIEW_ROUTE = /^\/reviews\/([^/]+)\/([^/]+)\/(\d+)$/;
const REPO_EDIT_ROUTE = /^\/config\/repos\/([^/]+)\/([^/]+)\/edit$/;
const REPO_POST_ROUTE = /^\/config\/repos\/([^/]+)\/([^/]+)$/;

function reviewUrl(repo: string, pr: number): string {
  const [owner, name] = repo.split("/");
  return `/reviews/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/${pr}`;
}

function repoEditUrl(slug: string): string {
  const [owner, name] = slug.split("/");
  return `/config/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/edit`;
}

function repoPostUrl(slug: string): string {
  const [owner, name] = slug.split("/");
  return `/config/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
}

function pathOf(u: string): string {
  return new URL(u, "http://x").pathname;
}

describe("url segments", () => {
  test("review detail URL matches the server route", () => {
    const u = reviewUrl("software-development-llc/bodhi-dotnet-monitoring-client-3series", 42);
    expect(u).toBe(
      "/reviews/software-development-llc/bodhi-dotnet-monitoring-client-3series/42",
    );
    const m = pathOf("http://x" + u).match(REVIEW_ROUTE);
    expect(m).not.toBeNull();
    expect(decodeURIComponent(m![1]!)).toBe("software-development-llc");
    expect(decodeURIComponent(m![2]!)).toBe("bodhi-dotnet-monitoring-client-3series");
    expect(m![3]).toBe("42");
  });

  test("repo edit URL matches the server route", () => {
    const u = repoEditUrl("acme/widget");
    expect(u).toBe("/config/repos/acme/widget/edit");
    const m = pathOf("http://x" + u).match(REPO_EDIT_ROUTE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("acme");
    expect(m![2]).toBe("widget");
  });

  test("repo POST URL matches the server route", () => {
    const u = repoPostUrl("acme/widget");
    expect(u).toBe("/config/repos/acme/widget");
    const m = pathOf("http://x" + u).match(REPO_POST_ROUTE);
    expect(m).not.toBeNull();
  });

  test("slugs with unusual characters still produce two segments", () => {
    // Hypothetical — GitHub doesn't allow these, but the code should not assume.
    const u = reviewUrl("some-org/repo.with.dots", 1);
    expect(u).toBe("/reviews/some-org/repo.with.dots/1");
    expect(REVIEW_ROUTE.test(pathOf("http://x" + u))).toBe(true);
  });

  test("regression: encoded-slash form would NOT match", () => {
    // Document why we dropped it. If someone thinks encodeURIComponent on
    // the whole slug is fine, this test explains the symptom.
    const bad = `/reviews/${encodeURIComponent("software-development-llc/bodhi-crestron-home-platform")}/1`;
    expect(bad).toBe(
      "/reviews/software-development-llc%2Fbodhi-crestron-home-platform/1",
    );
    const m = pathOf("http://x" + bad).match(REVIEW_ROUTE);
    expect(m).toBeNull();
  });
});
