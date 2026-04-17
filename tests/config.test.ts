import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  const base = {
    GITHUB_PAT: "pat",
    GITHUB_WEBHOOK_SECRET: "secret",
    ANTHROPIC_API_KEY: "anthropic",
  } as unknown as NodeJS.ProcessEnv;

  test("parses minimal required env", () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(3000);
    expect(cfg.hostname).toBe("127.0.0.1");
    expect(cfg.githubPat).toBe("pat");
    expect(cfg.jira).toBeUndefined();
  });

  test("populates jira block only when all three vars are set", () => {
    const cfg = loadConfig({
      ...base,
      JIRA_BASE_URL: "https://example.atlassian.net",
      JIRA_EMAIL: "me@example.com",
      JIRA_API_TOKEN: "token",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.jira).toEqual({
      baseUrl: "https://example.atlassian.net",
      email: "me@example.com",
      apiToken: "token",
    });
  });

  test("throws when a required var is missing", () => {
    expect(() =>
      loadConfig({ GITHUB_PAT: "pat" } as unknown as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
