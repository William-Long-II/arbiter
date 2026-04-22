import { describe, expect, test } from "bun:test";
import { resolveTone } from "../src/review/tone.ts";
import type { Config } from "../src/config.ts";

const DEFAULT_TONE = "Default: be kind.";

function makeCfg(overrides: {
  orgs?: Config["watch"]["orgs"];
  repos?: Config["watch"]["repos"];
}): Config {
  return {
    github: { bot_username: "bot", skip_authors: [] },
    watch: {
      orgs: overrides.orgs ?? [],
      repos: overrides.repos ?? [],
    },
    review: {
      dry_run: true,
      max_approvals_per_hour: 10,
      tone: DEFAULT_TONE,
      skip_drafts: true,
      require_ci_green: true,
    },
    poll: { interval_seconds: 60 },
    claude: { command: "claude", timeout_seconds: 600 },
  };
}

describe("resolveTone", () => {
  test("falls back to default when no org and no repo match", () => {
    const cfg = makeCfg({});
    expect(resolveTone({ cfg, owner: "unk", name: "thing" })).toBe(DEFAULT_TONE);
  });

  test("org append adds to default", () => {
    const cfg = makeCfg({
      orgs: [
        {
          name: "acme",
          mode: "all",
          include: [],
          exclude: [],
          tone_override: "ORG: watch for PII.",
          tone_mode: "append",
        },
      ],
    });
    const out = resolveTone({ cfg, owner: "acme", name: "web" });
    expect(out).toContain(DEFAULT_TONE);
    expect(out).toContain("ORG: watch for PII.");
    expect(out.indexOf(DEFAULT_TONE)).toBeLessThan(out.indexOf("ORG: watch for PII."));
  });

  test("org replace wipes default", () => {
    const cfg = makeCfg({
      orgs: [
        {
          name: "acme",
          mode: "all",
          include: [],
          exclude: [],
          tone_override: "ORG ONLY",
          tone_mode: "replace",
        },
      ],
    });
    const out = resolveTone({ cfg, owner: "acme", name: "web" });
    expect(out).toBe("ORG ONLY");
    expect(out).not.toContain(DEFAULT_TONE);
  });

  test("repo append layers on top of org", () => {
    const cfg = makeCfg({
      orgs: [
        {
          name: "acme",
          mode: "all",
          include: [],
          exclude: [],
          tone_override: "ORG: PII.",
          tone_mode: "append",
        },
      ],
      repos: [
        { slug: "acme/web", tone_override: "REPO: hot path.", tone_mode: "append" },
      ],
    });
    const out = resolveTone({ cfg, owner: "acme", name: "web" });
    expect(out).toContain(DEFAULT_TONE);
    expect(out).toContain("ORG: PII.");
    expect(out).toContain("REPO: hot path.");
    expect(out.indexOf("ORG: PII.")).toBeLessThan(out.indexOf("REPO: hot path."));
  });

  test("repo replace wipes BOTH org and default", () => {
    const cfg = makeCfg({
      orgs: [
        {
          name: "acme",
          mode: "all",
          include: [],
          exclude: [],
          tone_override: "ORG: PII.",
          tone_mode: "append",
        },
      ],
      repos: [
        { slug: "acme/web", tone_override: "REPO ONLY", tone_mode: "replace" },
      ],
    });
    const out = resolveTone({ cfg, owner: "acme", name: "web" });
    expect(out).toBe("REPO ONLY");
    expect(out).not.toContain(DEFAULT_TONE);
    expect(out).not.toContain("ORG: PII.");
  });

  test("null overrides at both levels inherit default", () => {
    const cfg = makeCfg({
      orgs: [
        {
          name: "acme",
          mode: "all",
          include: [],
          exclude: [],
          tone_override: null,
          tone_mode: "append",
        },
      ],
      repos: [{ slug: "acme/web", tone_override: null, tone_mode: "append" }],
    });
    expect(resolveTone({ cfg, owner: "acme", name: "web" })).toBe(DEFAULT_TONE);
  });

  test("org hit ignores repos on other orgs", () => {
    const cfg = makeCfg({
      orgs: [
        {
          name: "acme",
          mode: "all",
          include: [],
          exclude: [],
          tone_override: "ACME tone",
          tone_mode: "replace",
        },
      ],
    });
    expect(resolveTone({ cfg, owner: "partner", name: "repo-a" })).toBe(DEFAULT_TONE);
  });

  test("repo match is case-insensitive on slug", () => {
    const cfg = makeCfg({
      repos: [
        { slug: "Acme/Web", tone_override: "REPO", tone_mode: "replace" },
      ],
    });
    expect(resolveTone({ cfg, owner: "acme", name: "web" })).toBe("REPO");
  });

  test("empty-string replace intentionally silences default", () => {
    const cfg = makeCfg({
      repos: [{ slug: "acme/web", tone_override: "", tone_mode: "replace" }],
    });
    expect(resolveTone({ cfg, owner: "acme", name: "web" })).toBe("");
  });
});
