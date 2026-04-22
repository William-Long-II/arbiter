import { describe, expect, test } from "bun:test";
import { filterReviewable, type PullRef } from "../src/github/discover.ts";
import type { Config } from "../src/config.ts";

function makeCfg(overrides: Partial<Config["review"]> = {}): Config {
  return {
    github: { bot_username: "my-bot", skip_authors: [] },
    watch: { orgs: [], repos: [] },
    review: {
      dry_run: true,
      max_approvals_per_hour: 10,
      tone: "t",
      skip_drafts: true,
      skip_bots: true,
      require_ci_green: true,
      ...overrides,
    },
    poll: { interval_seconds: 60 },
    claude: { command: "claude", timeout_seconds: 600 },
  };
}

function pr(overrides: Partial<PullRef> = {}): PullRef {
  return {
    repo: { owner: "acme", name: "widget" },
    number: 1,
    head_sha: "sha",
    author: "alice",
    author_is_bot: false,
    draft: false,
    title: "title",
    ...overrides,
  };
}

describe("filterReviewable with skip_bots", () => {
  test("default config skips bot PRs", () => {
    const prs = [
      pr({ number: 1, author: "alice", author_is_bot: false }),
      pr({ number: 2, author: "dependabot[bot]", author_is_bot: true }),
      pr({ number: 3, author: "renovate[bot]", author_is_bot: true }),
    ];
    const kept = filterReviewable(prs, makeCfg());
    expect(kept.map((p) => p.number)).toEqual([1]);
  });

  test("skip_bots=false keeps bot PRs", () => {
    const prs = [
      pr({ number: 1, author: "alice", author_is_bot: false }),
      pr({ number: 2, author: "dependabot[bot]", author_is_bot: true }),
    ];
    const kept = filterReviewable(prs, makeCfg({ skip_bots: false }));
    expect(kept.map((p) => p.number)).toEqual([1, 2]);
  });

  test("skip_authors still applies regardless of skip_bots flag", () => {
    const prs = [
      pr({ number: 1, author: "alice", author_is_bot: false }),
      pr({ number: 2, author: "dependabot[bot]", author_is_bot: true }),
    ];
    const cfg = makeCfg({ skip_bots: false });
    cfg.github.skip_authors = ["alice"];
    const kept = filterReviewable(prs, cfg);
    expect(kept.map((p) => p.number)).toEqual([2]);
  });

  test("the bot's own login is always skipped even if author_is_bot is false", () => {
    // Our own bot user could be reported as type: User on PAT auth — cover the
    // existing explicit-skip path to prove skip_bots didn't regress it.
    const prs = [
      pr({ number: 1, author: "my-bot", author_is_bot: false }),
      pr({ number: 2, author: "alice", author_is_bot: false }),
    ];
    const kept = filterReviewable(prs, makeCfg());
    expect(kept.map((p) => p.number)).toEqual([2]);
  });

  test("a human PR marked as Bot (misconfigured GitHub) is still skipped by default", () => {
    // Defensive: whatever GitHub says is authoritative. If they mark it Bot,
    // treat it as a bot. User can flip skip_bots off to override.
    const prs = [pr({ number: 1, author: "someone", author_is_bot: true })];
    expect(filterReviewable(prs, makeCfg())).toHaveLength(0);
    expect(filterReviewable(prs, makeCfg({ skip_bots: false }))).toHaveLength(1);
  });
});
