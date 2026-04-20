import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { fetchGitattributes, _clearGitattributesCache } from "../src/github/gitattributes";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal Octokit mock with a configurable getContent response. */
function makeOctokit(handler: () => Promise<unknown>) {
  return {
    repos: {
      getContent: (_params: unknown) => handler(),
    },
  } as unknown as Parameters<typeof fetchGitattributes>[0]["octokit"];
}

/** Standard file-shape response from repos.getContent. */
function fileResponse(content: string) {
  return {
    data: {
      type: "file" as const,
      content: Buffer.from(content).toString("base64"),
      encoding: "base64",
    },
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  _clearGitattributesCache();
});

afterEach(() => {
  _clearGitattributesCache();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("fetchGitattributes — 200 response", () => {
  test("returns decoded content", async () => {
    const content = "*.ts linguist-generated=true\n";
    const octokit = makeOctokit(async () => fileResponse(content));

    const result = await fetchGitattributes({
      octokit,
      owner: "acme",
      repo: "widget",
      ref: "abc123",
    });

    expect(result).toBe(content);
  });

  test("cache hit avoids a second Octokit call", async () => {
    let callCount = 0;
    const content = "dist/** linguist-generated=true\n";
    const octokit = makeOctokit(async () => {
      callCount++;
      return fileResponse(content);
    });

    await fetchGitattributes({ octokit, owner: "acme", repo: "widget", ref: "sha1" });
    await fetchGitattributes({ octokit, owner: "acme", repo: "widget", ref: "sha1" });

    expect(callCount).toBe(1);
  });

  test("different ref keys do not share a cache entry", async () => {
    let callCount = 0;
    const octokit = makeOctokit(async () => {
      callCount++;
      return fileResponse("# empty\n");
    });

    await fetchGitattributes({ octokit, owner: "acme", repo: "widget", ref: "sha1" });
    await fetchGitattributes({ octokit, owner: "acme", repo: "widget", ref: "sha2" });

    expect(callCount).toBe(2);
  });
});

describe("fetchGitattributes — 404 response", () => {
  test("returns null silently (no throw, no warn log)", async () => {
    const stderrSpy = mock(() => {});
    const originalConsoleError = console.error;
    console.error = stderrSpy;

    try {
      const octokit = makeOctokit(async () => {
        const err = Object.assign(new Error("Not Found"), { status: 404 });
        throw err;
      });

      const result = await fetchGitattributes({
        octokit,
        owner: "acme",
        repo: "widget",
        ref: "abc123",
      });

      expect(result).toBeNull();
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("404 result is cached (does not re-fetch on second call)", async () => {
    let callCount = 0;
    const octokit = makeOctokit(async () => {
      callCount++;
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    await fetchGitattributes({ octokit, owner: "acme", repo: "widget", ref: "sha1" });
    await fetchGitattributes({ octokit, owner: "acme", repo: "widget", ref: "sha1" });

    expect(callCount).toBe(1);
  });
});

describe("fetchGitattributes — 500 response", () => {
  test("returns null and emits a warn-level structured log", async () => {
    const logLines: string[] = [];
    const originalConsoleError = console.error;
    console.error = (line: string) => logLines.push(line);

    try {
      const octokit = makeOctokit(async () => {
        throw Object.assign(new Error("Internal Server Error"), { status: 500 });
      });

      const result = await fetchGitattributes({
        octokit,
        owner: "acme",
        repo: "widget",
        ref: "abc123",
      });

      expect(result).toBeNull();
      expect(logLines).toHaveLength(1);

      const parsed = JSON.parse(logLines[0]!) as Record<string, unknown>;
      expect(parsed["level"]).toBe("warn");
      expect(parsed["evt"]).toBe("gitattributes.fetch_failed");
      expect(parsed["owner"]).toBe("acme");
      expect(parsed["repo"]).toBe("widget");
      expect(parsed["ref"]).toBe("abc123");
    } finally {
      console.error = originalConsoleError;
    }
  });

  test("500 result is NOT cached (next call retries)", async () => {
    let callCount = 0;
    const octokit = makeOctokit(async () => {
      callCount++;
      throw Object.assign(new Error("Internal Server Error"), { status: 500 });
    });

    await fetchGitattributes({ octokit, owner: "acme", repo: "widget", ref: "sha1" });
    await fetchGitattributes({ octokit, owner: "acme", repo: "widget", ref: "sha1" });

    expect(callCount).toBe(2);
  });
});

describe("fetchGitattributes — array response (directory shape)", () => {
  test("returns null when getContent returns an array", async () => {
    const octokit = makeOctokit(async () => ({
      data: [
        { type: "file", name: "foo.ts" },
        { type: "file", name: "bar.ts" },
      ],
    }));

    const result = await fetchGitattributes({
      octokit,
      owner: "acme",
      repo: "widget",
      ref: "abc123",
    });

    expect(result).toBeNull();
  });
});

describe("fetchGitattributes — TTL expiry", () => {
  test("second call after TTL re-fetches", async () => {
    const now = Date.now();
    let callCount = 0;

    const octokit = makeOctokit(async () => {
      callCount++;
      return fileResponse("# attrs\n");
    });

    // First call populates the cache.
    using _dateSpy = (() => {
      const orig = Date.now;
      Date.now = () => now;
      return { [Symbol.dispose]: () => { Date.now = orig; } };
    })();

    await fetchGitattributes({ octokit, owner: "acme", repo: "widget", ref: "sha1" });
    expect(callCount).toBe(1);

    // Advance time past the 10-minute TTL.
    Date.now = () => now + 11 * 60 * 1_000;

    await fetchGitattributes({ octokit, owner: "acme", repo: "widget", ref: "sha1" });
    expect(callCount).toBe(2);
  });
});
