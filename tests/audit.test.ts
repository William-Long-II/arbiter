import { describe, expect, test } from "bun:test";
import { diffGeneralConfig, currentActor, recordAudit } from "../src/audit.ts";
import type { Config } from "../src/config.ts";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/state/db.ts";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "auto-reviewer-test-"));
  return {
    path: join(dir, "state.sqlite"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
}

function baseCfg(): Config {
  return {
    github: { bot_username: "bot", skip_authors: [] },
    watch: { orgs: [], repos: [] },
    review: {
      dry_run: true,
      max_approvals_per_hour: 10,
      tone: "t",
      skip_drafts: true,
      skip_bots: true,
      require_ci_green: true,
      concurrency: 1,
      include_paths: [],
      exclude_paths: [],
    },
    poll: { interval_seconds: 60 },
    claude: { command: "claude", timeout_seconds: 600 },
  };
}

describe("diffGeneralConfig", () => {
  test("no differences → empty array", () => {
    expect(diffGeneralConfig(baseCfg(), baseCfg())).toEqual([]);
  });

  test("boolean flag change", () => {
    const after = baseCfg();
    after.review.dry_run = false;
    const d = diffGeneralConfig(baseCfg(), after);
    expect(d).toHaveLength(1);
    expect(d[0]!.path).toBe("review.dry_run");
    expect(d[0]!.from).toBe("true");
    expect(d[0]!.to).toBe("false");
  });

  test("numeric change", () => {
    const after = baseCfg();
    after.review.concurrency = 3;
    const d = diffGeneralConfig(baseCfg(), after);
    expect(d).toHaveLength(1);
    expect(d[0]!.path).toBe("review.concurrency");
    expect(d[0]!.from).toBe("1");
    expect(d[0]!.to).toBe("3");
  });

  test("tone change produces a size + preview summary, not a full dump", () => {
    const after = baseCfg();
    after.review.tone = "x".repeat(5000);
    const d = diffGeneralConfig(baseCfg(), after);
    expect(d).toHaveLength(1);
    expect(d[0]!.path).toBe("review.tone");
    expect(d[0]!.to).toContain("(5000 chars)");
    // Guards against dumping the whole 5000-char string into the audit log.
    expect(d[0]!.to!.length).toBeLessThan(200);
  });

  test("string list change shows a summary with sample entries", () => {
    const after = baseCfg();
    after.review.exclude_paths = ["**/*.lock", "**/dist/**", "**/node_modules/**"];
    const d = diffGeneralConfig(baseCfg(), after);
    expect(d).toHaveLength(1);
    expect(d[0]!.path).toBe("review.exclude_paths");
    expect(d[0]!.from).toBe("[]");
    expect(d[0]!.to).toContain("**/*.lock");
  });

  test("long list is truncated in the summary", () => {
    const after = baseCfg();
    after.review.include_paths = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const d = diffGeneralConfig(baseCfg(), after);
    expect(d[0]!.to).toContain("… +7");
    // Only the first 3 appear explicitly
    expect(d[0]!.to).toContain('"p0"');
    expect(d[0]!.to).not.toContain('"p5"');
  });

  test("reordering a list does not count as a change", () => {
    const before = baseCfg();
    before.github.skip_authors = ["alice", "bob"];
    const after = baseCfg();
    after.github.skip_authors = ["bob", "alice"];
    expect(diffGeneralConfig(before, after)).toEqual([]);
  });

  test("multiple changes emit in stable order", () => {
    const after = baseCfg();
    after.review.dry_run = false;
    after.review.concurrency = 2;
    after.poll.interval_seconds = 30;
    const d = diffGeneralConfig(baseCfg(), after);
    expect(d.map((c) => c.path)).toEqual([
      "review.dry_run",
      "review.concurrency",
      "poll.interval_seconds",
    ]);
  });
});

describe("currentActor", () => {
  test("defaults to 'operator' when env var is unset", () => {
    const prev = process.env.AUTO_REVIEWER_OPERATOR;
    delete process.env.AUTO_REVIEWER_OPERATOR;
    try {
      expect(currentActor()).toBe("operator");
    } finally {
      if (prev !== undefined) process.env.AUTO_REVIEWER_OPERATOR = prev;
    }
  });

  test("uses AUTO_REVIEWER_OPERATOR when set", () => {
    const prev = process.env.AUTO_REVIEWER_OPERATOR;
    process.env.AUTO_REVIEWER_OPERATOR = "will@example.com";
    try {
      expect(currentActor()).toBe("will@example.com");
    } finally {
      if (prev !== undefined) process.env.AUTO_REVIEWER_OPERATOR = prev;
      else delete process.env.AUTO_REVIEWER_OPERATOR;
    }
  });
});

describe("recordAudit", () => {
  test("writes an event with kind=audit.<action> and a descriptive message", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      recordAudit(store, {
        actor: "alice",
        action: "config.repo.add",
        target: "acme/widget",
      });
      const ev = store.recentEvents(1);
      expect(ev).toHaveLength(1);
      expect(ev[0]!.kind).toBe("audit.config.repo.add");
      expect(ev[0]!.message).toContain("alice");
      expect(ev[0]!.message).toContain("added repo");
      expect(ev[0]!.message).toContain("acme/widget");
      store.close();
    } finally {
      cleanup();
    }
  });

  test("includes the changes array in the payload", () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      recordAudit(store, {
        actor: "bob",
        action: "config.general.save",
        changes: [
          { path: "review.dry_run", from: "true", to: "false" },
          { path: "review.concurrency", from: "1", to: "2" },
        ],
      });
      const ev = store.recentEvents(1);
      const payload = JSON.parse(ev[0]!.payload!) as { actor: string; changes: unknown[] };
      expect(payload.actor).toBe("bob");
      expect(payload.changes).toHaveLength(2);
      store.close();
    } finally {
      cleanup();
    }
  });
});
