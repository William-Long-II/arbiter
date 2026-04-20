/**
 * Tests for src/server/dead-letter-replay.ts
 *
 * Five replay paths tested:
 *   1. New file (within max age) is replayed and renamed to .replayed
 *   2. Old file (> max age) is skipped (not replayed, not renamed)
 *   3. File already renamed to <name>.json.replayed is skipped (no fs read past listing)
 *   4. Over-count cap: extras are skipped even if within age window
 *   5. Handler failure leaves the file unchanged and increments failure counter
 *
 * Plus:
 *   - DEAD_LETTER_AUTO_REPLAY=disabled is a complete no-op (no fs reads)
 *   - Integration: write a synthetic dead-letter, run replay, confirm handler saw
 *     the payload and the file was renamed
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeadLetterEntry } from "../src/server/dead-letter";
import { replayOne, replayRecentDeadLetters } from "../src/server/dead-letter-replay";
import { registry } from "../src/server/metrics";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_DIR = join(
  import.meta.dir,
  "..",
  "var",
  "test-dl-replay",
  `run-${Date.now()}`,
);

/** The bypass secret used in all tests. */
const SECRET = "__test_bypass__";

function makeEntry(
  id: string,
  writtenAt: Date,
  payload = "{}",
): DeadLetterEntry {
  return {
    delivery_id: id,
    event: "pull_request",
    headers: { "x-github-delivery": id },
    payload,
    error: { message: "test error" },
    attempts: 1,
    written_at: writtenAt.toISOString(),
  };
}

async function writeEntry(dir: string, name: string, entry: DeadLetterEntry): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(entry, null, 2) + "\n", "utf8");
  return path;
}

/** Build a minimal webhooks stub that calls the optional onReceive callback. */
function makeWebhooks(
  onReceive?: (id: string) => void,
  shouldThrow = false,
) {
  return {
    verifyAndReceive: async (opts: {
      id: string;
      name: string;
      signature: string;
      payload: string;
    }) => {
      if (shouldThrow) throw new Error("handler failure");
      onReceive?.(opts.id);
    },
  } as ReturnType<typeof import("../src/server/webhooks").createWebhooks>;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await mkdir(BASE_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(BASE_DIR, { recursive: true, force: true });
});

// Reset DEAD_LETTER_AUTO_REPLAY around each test.
let savedAutoReplay: string | undefined;
beforeEach(() => {
  savedAutoReplay = process.env.DEAD_LETTER_AUTO_REPLAY;
  delete process.env.DEAD_LETTER_AUTO_REPLAY;
});
afterEach(() => {
  if (savedAutoReplay !== undefined) {
    process.env.DEAD_LETTER_AUTO_REPLAY = savedAutoReplay;
  } else {
    delete process.env.DEAD_LETTER_AUTO_REPLAY;
  }
});

// ---------------------------------------------------------------------------
// replayOne unit tests
// ---------------------------------------------------------------------------

describe("replayOne", () => {
  test("returns success and renames file when handler completes", async () => {
    const dir = join(BASE_DIR, "replay-one-success");
    await mkdir(dir, { recursive: true });
    const now = new Date();
    const entry = makeEntry("delivery-success-01", now);
    const path = await writeEntry(dir, "delivery-success-01.json", entry);

    const received: string[] = [];
    const wh = makeWebhooks((id) => received.push(id));

    const result = await replayOne(path, wh, SECRET);

    expect(result).toBe("success");
    expect(received).toContain("delivery-success-01");

    // File should be renamed to .replayed.
    const files = await readdir(dir);
    expect(files).toContain("delivery-success-01.json.replayed");
    expect(files).not.toContain("delivery-success-01.json");
  });

  test("returns failure and leaves file in place when handler throws", async () => {
    const dir = join(BASE_DIR, "replay-one-failure");
    await mkdir(dir, { recursive: true });
    const entry = makeEntry("delivery-fail-01", new Date());
    const path = await writeEntry(dir, "delivery-fail-01.json", entry);

    const wh = makeWebhooks(undefined, true /* shouldThrow */);

    const result = await replayOne(path, wh, SECRET);

    expect(result).toBe("failure");

    // Original file must still exist.
    const files = await readdir(dir);
    expect(files).toContain("delivery-fail-01.json");
    expect(files).not.toContain("delivery-fail-01.json.replayed");
  });

  test("returns failure when file does not exist", async () => {
    const wh = makeWebhooks();
    const result = await replayOne("/nonexistent/path/file.json", wh, SECRET);
    expect(result).toBe("failure");
  });

  test("returns failure when file contains invalid JSON", async () => {
    const dir = join(BASE_DIR, "replay-one-bad-json");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "bad.json");
    await writeFile(path, "not json", "utf8");

    const wh = makeWebhooks();
    const result = await replayOne(path, wh, SECRET);
    expect(result).toBe("failure");

    // File must remain untouched.
    const files = await readdir(dir);
    expect(files).toContain("bad.json");
  });
});

// ---------------------------------------------------------------------------
// replayRecentDeadLetters unit tests
// ---------------------------------------------------------------------------

describe("replayRecentDeadLetters", () => {
  function makeOpts(
    dir: string,
    now: Date,
    overrides: Partial<Parameters<typeof replayRecentDeadLetters>[0]> = {},
  ): Parameters<typeof replayRecentDeadLetters>[0] {
    return {
      dir,
      maxAgeMinutes: 60,
      maxCount: 50,
      webhooks: makeWebhooks(),
      replaySecret: SECRET,
      now,
      ...overrides,
    };
  }

  function dateDirStr(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  test("replays files within max age and renames them to .replayed", async () => {
    const dir = join(BASE_DIR, "recent-basic");
    const now = new Date("2024-06-15T12:00:00Z");
    const todayDir = join(dir, dateDirStr(now));
    await mkdir(todayDir, { recursive: true });

    // 30 minutes old — within 60-minute window.
    const recent = makeEntry("d-recent-01", new Date(now.getTime() - 30 * 60 * 1_000));
    await writeEntry(todayDir, "d-recent-01.json", recent);

    const received: string[] = [];
    const opts = makeOpts(dir, now, { webhooks: makeWebhooks((id) => received.push(id)) });
    const summary = await replayRecentDeadLetters(opts);

    expect(summary.success).toBe(1);
    expect(summary.failure).toBe(0);
    expect(received).toContain("d-recent-01");

    const files = await readdir(todayDir);
    expect(files).toContain("d-recent-01.json.replayed");
    expect(files).not.toContain("d-recent-01.json");
  });

  test("skips files older than maxAgeMinutes", async () => {
    const dir = join(BASE_DIR, "recent-age-skip");
    const now = new Date("2024-06-15T12:00:00Z");
    const todayDir = join(dir, dateDirStr(now));
    await mkdir(todayDir, { recursive: true });

    // 90 minutes old — outside 60-minute window.
    const old = makeEntry("d-old-01", new Date(now.getTime() - 90 * 60 * 1_000));
    await writeEntry(todayDir, "d-old-01.json", old);

    const received: string[] = [];
    const opts = makeOpts(dir, now, { webhooks: makeWebhooks((id) => received.push(id)) });
    const summary = await replayRecentDeadLetters(opts);

    expect(summary.success).toBe(0);
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect(received.length).toBe(0);

    // File must be untouched.
    const files = await readdir(todayDir);
    expect(files).toContain("d-old-01.json");
  });

  test("skips files that are already .replayed", async () => {
    const dir = join(BASE_DIR, "recent-already-replayed");
    const now = new Date("2024-06-15T12:00:00Z");
    const todayDir = join(dir, dateDirStr(now));
    await mkdir(todayDir, { recursive: true });

    // Write a file with the .replayed extension — these are never listed as candidates.
    const entry = makeEntry("d-done-01", new Date(now.getTime() - 5 * 60 * 1_000));
    await writeFile(
      join(todayDir, "d-done-01.json.replayed"),
      JSON.stringify(entry),
      "utf8",
    );

    const received: string[] = [];
    const opts = makeOpts(dir, now, { webhooks: makeWebhooks((id) => received.push(id)) });
    const summary = await replayRecentDeadLetters(opts);

    expect(summary.success).toBe(0);
    expect(received.length).toBe(0);
  });

  test("respects maxCount cap: extras are skipped", async () => {
    const dir = join(BASE_DIR, "recent-cap");
    const now = new Date("2024-06-15T12:00:00Z");
    const todayDir = join(dir, dateDirStr(now));
    await mkdir(todayDir, { recursive: true });

    // Write 5 files all within age window.
    for (let i = 1; i <= 5; i++) {
      const ts = new Date(now.getTime() - i * 5 * 60 * 1_000); // 5,10,15,20,25 min old
      await writeEntry(todayDir, `d-cap-0${i}.json`, makeEntry(`d-cap-0${i}`, ts));
    }

    const received: string[] = [];
    // maxCount=3 means 2 are skipped.
    const opts = makeOpts(dir, now, {
      maxCount: 3,
      webhooks: makeWebhooks((id) => received.push(id)),
    });
    const summary = await replayRecentDeadLetters(opts);

    expect(summary.success).toBe(3);
    expect(summary.skipped).toBeGreaterThanOrEqual(2);
    expect(received.length).toBe(3);
  });

  test("handler failure leaves file in place and counts as failure", async () => {
    const dir = join(BASE_DIR, "recent-handler-failure");
    const now = new Date("2024-06-15T12:00:00Z");
    const todayDir = join(dir, dateDirStr(now));
    await mkdir(todayDir, { recursive: true });

    const entry = makeEntry("d-fail-02", new Date(now.getTime() - 10 * 60 * 1_000));
    await writeEntry(todayDir, "d-fail-02.json", entry);

    const opts = makeOpts(dir, now, {
      webhooks: makeWebhooks(undefined, true /* shouldThrow */),
    });
    const summary = await replayRecentDeadLetters(opts);

    expect(summary.failure).toBe(1);
    expect(summary.success).toBe(0);

    // File must still be present.
    const files = await readdir(todayDir);
    expect(files).toContain("d-fail-02.json");
  });

  test("DEAD_LETTER_AUTO_REPLAY=disabled is a no-op (no fs access needed)", async () => {
    process.env.DEAD_LETTER_AUTO_REPLAY = "disabled";

    // Point at a non-existent dir so any fs read would cause an error.
    const opts = makeOpts("/does/not/exist/at/all", new Date());
    const summary = await replayRecentDeadLetters(opts);

    expect(summary.success).toBe(0);
    expect(summary.failure).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  test("missing dead-letter dir is a no-op (no throw)", async () => {
    const dir = join(BASE_DIR, "missing-dir");
    const now = new Date();
    const opts = makeOpts(dir, now);
    // Should not throw.
    const summary = await replayRecentDeadLetters(opts);
    expect(summary.success).toBe(0);
  });

  test("reads yesterday dir as well as today dir (night-time boundary)", async () => {
    const dir = join(BASE_DIR, "recent-yesterday");
    const now = new Date("2024-06-15T00:30:00Z"); // 30 min into today
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
    const yesterdayDir = join(dir, dateDirStr(yesterday));
    await mkdir(yesterdayDir, { recursive: true });

    // 20 minutes ago but in yesterday's date dir.
    const entry = makeEntry("d-yest-01", new Date(now.getTime() - 20 * 60 * 1_000));
    await writeEntry(yesterdayDir, "d-yest-01.json", entry);

    const received: string[] = [];
    const opts = makeOpts(dir, now, { webhooks: makeWebhooks((id) => received.push(id)) });
    const summary = await replayRecentDeadLetters(opts);

    expect(summary.success).toBe(1);
    expect(received).toContain("d-yest-01");
  });
});

// ---------------------------------------------------------------------------
// Integration test: write a real dead-letter, run replay, confirm rename
// ---------------------------------------------------------------------------

describe("integration: write dead-letter and auto-replay", () => {
  test("handler receives payload and file is renamed to .replayed", async () => {
    const dir = join(BASE_DIR, "integration");
    const now = new Date();

    // Compute the today dir path.
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    const d = String(now.getUTCDate()).padStart(2, "0");
    const todayDir = join(dir, `${y}-${m}-${d}`);
    await mkdir(todayDir, { recursive: true });

    const payload = JSON.stringify({
      action: "opened",
      number: 42,
      pull_request: { number: 42, head: { sha: "abc123" } },
      repository: { full_name: "test/repo" },
      sender: { login: "tester" },
    });

    const entry = makeEntry("integration-dl-01", new Date(now.getTime() - 5 * 60 * 1_000), payload);
    const filePath = await writeEntry(todayDir, "integration-dl-01.json", entry);

    // Build a real-ish webhooks instance to verify the payload flows through.
    const { createWebhooks } = await import("../src/server/webhooks");
    const { buildAllowlist } = await import("../src/config/repos");
    const emptyAllowlist = buildAllowlist({});

    const receivedPayloads: string[] = [];
    const webhooks = createWebhooks(SECRET, {
      getAllowlist: () => emptyAllowlist,
      octokit: {} as never,
      anthropic: {} as never,
      selfLogin: "test-bot",
    });
    webhooks.onAny(({ payload: p }) => {
      receivedPayloads.push(JSON.stringify(p));
    });

    const summary = await replayRecentDeadLetters({
      dir,
      maxAgeMinutes: 60,
      maxCount: 10,
      webhooks,
      replaySecret: SECRET,
      now,
    });

    expect(summary.success).toBe(1);
    expect(summary.failure).toBe(0);

    // Handler must have received the payload.
    expect(receivedPayloads.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(receivedPayloads[0]!) as { number: number };
    expect(parsed.number).toBe(42);

    // File must have been renamed.
    const files = await readdir(todayDir);
    expect(files).toContain("integration-dl-01.json.replayed");
    expect(files).not.toContain("integration-dl-01.json");

    // Verify we can still read the .replayed file (audit trail preserved).
    const raw = await readFile(join(todayDir, "integration-dl-01.json.replayed"), "utf8");
    const saved = JSON.parse(raw) as DeadLetterEntry;
    expect(saved.delivery_id).toBe("integration-dl-01");
  });
});
