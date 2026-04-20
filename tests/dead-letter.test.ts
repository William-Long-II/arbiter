import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sweepDeadLetters, writeDeadLetter } from "../src/server/dead-letter";
import type { DeadLetterEntry } from "../src/server/dead-letter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Use a temp directory isolated per test run to avoid cross-test pollution. */
const BASE_DIR = join(
  import.meta.dir,
  "..",
  "var",
  "test-dead-letter",
  `run-${Date.now()}`,
);

beforeAll(async () => {
  await mkdir(BASE_DIR, { recursive: true });
  // Point the module at our test dir.
  process.env.DEAD_LETTER_DIR = BASE_DIR;
  process.env.DEAD_LETTER_SWEEP = "false"; // don't run sweeper except in sweep tests
});

afterAll(async () => {
  delete process.env.DEAD_LETTER_DIR;
  delete process.env.DEAD_LETTER_SWEEP;
  await rm(BASE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writeDeadLetter tests
// ---------------------------------------------------------------------------

describe("writeDeadLetter", () => {
  test("creates exactly one dead-letter file for a failing event", async () => {
    const deliveryId = "dl-test-001";
    const error = new Error("handler blew up");

    await writeDeadLetter({
      delivery_id: deliveryId,
      event: "pull_request",
      headers: {
        "x-github-delivery": deliveryId,
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=secret",
        "x-hub-signature": "sha1=oldsecret",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ action: "opened" }),
      error,
      attempts: 1,
    });

    // Exactly one date-dir should exist.
    const dateDirs = (await readdir(BASE_DIR)).filter((d) =>
      /^\d{4}-\d{2}-\d{2}$/.test(d),
    );
    expect(dateDirs.length).toBeGreaterThanOrEqual(1);

    // The file for our delivery should exist.
    const todayDir = dateDirs[dateDirs.length - 1]!;
    const files = await readdir(join(BASE_DIR, todayDir));
    const match = files.filter((f) => f === `${deliveryId}.json`);
    expect(match.length).toBe(1);

    // Parse and validate contents.
    const raw = await readFile(join(BASE_DIR, todayDir, `${deliveryId}.json`), "utf8");
    const entry = JSON.parse(raw) as DeadLetterEntry;

    expect(entry.delivery_id).toBe(deliveryId);
    expect(entry.event).toBe("pull_request");
    expect(entry.error.message).toBe("handler blew up");
    expect(entry.attempts).toBe(1);
    expect(entry.written_at).toBeTruthy();
  });

  test("strips x-hub-signature and x-hub-signature-256 from stored headers", async () => {
    const deliveryId = "dl-test-002";

    await writeDeadLetter({
      delivery_id: deliveryId,
      event: "check_suite",
      headers: {
        "x-github-delivery": deliveryId,
        "x-github-event": "check_suite",
        "x-hub-signature-256": "sha256=topsecret",
        "x-hub-signature": "sha1=legacysecret",
        "content-type": "application/json",
        "user-agent": "GitHub-Hookshot/abc123",
      },
      payload: "{}",
      error: new Error("pipeline error"),
      attempts: 2,
    });

    // Find the file.
    const dateDirs = (await readdir(BASE_DIR)).filter((d) =>
      /^\d{4}-\d{2}-\d{2}$/.test(d),
    );
    const todayDir = dateDirs[dateDirs.length - 1]!;
    const raw = await readFile(join(BASE_DIR, todayDir, `${deliveryId}.json`), "utf8");
    const entry = JSON.parse(raw) as DeadLetterEntry;

    // Signature headers must be absent.
    expect(Object.keys(entry.headers)).not.toContain("x-hub-signature-256");
    expect(Object.keys(entry.headers)).not.toContain("x-hub-signature");

    // Non-signature headers must survive.
    expect(entry.headers["content-type"]).toBe("application/json");
    expect(entry.headers["user-agent"]).toBe("GitHub-Hookshot/abc123");
  });

  test("does not throw when writing a duplicate delivery id (idempotent)", async () => {
    const deliveryId = "dl-test-003";

    await writeDeadLetter({
      delivery_id: deliveryId,
      event: "ping",
      headers: {},
      payload: "{}",
      error: new Error("first"),
      attempts: 1,
    });

    // Second write with same delivery id should not throw.
    await expect(
      writeDeadLetter({
        delivery_id: deliveryId,
        event: "ping",
        headers: {},
        payload: "{}",
        error: new Error("second"),
        attempts: 2,
      }),
    ).resolves.toBeUndefined();
  });

  test("serialises non-Error objects correctly", async () => {
    const deliveryId = "dl-test-004";

    await writeDeadLetter({
      delivery_id: deliveryId,
      event: "push",
      headers: {},
      payload: "{}",
      error: "plain string error",
      attempts: 1,
    });

    const dateDirs = (await readdir(BASE_DIR)).filter((d) =>
      /^\d{4}-\d{2}-\d{2}$/.test(d),
    );
    const todayDir = dateDirs[dateDirs.length - 1]!;
    const raw = await readFile(join(BASE_DIR, todayDir, `${deliveryId}.json`), "utf8");
    const entry = JSON.parse(raw) as DeadLetterEntry;

    expect(entry.error.message).toBe("plain string error");
  });
});

// ---------------------------------------------------------------------------
// sweepDeadLetters tests
// ---------------------------------------------------------------------------

describe("sweepDeadLetters", () => {
  let sweepBase: string;
  let savedSweep: string | undefined;

  beforeEach(async () => {
    // Isolated dir for each sweep test.
    sweepBase = join(BASE_DIR, `sweep-${Date.now()}`);
    await mkdir(sweepBase, { recursive: true });
    // Allow the sweeper to run (the outer beforeAll disables it for write tests).
    savedSweep = process.env.DEAD_LETTER_SWEEP;
    delete process.env.DEAD_LETTER_SWEEP;
  });

  afterEach(() => {
    // Restore whatever was set before the test.
    if (savedSweep !== undefined) {
      process.env.DEAD_LETTER_SWEEP = savedSweep;
    } else {
      delete process.env.DEAD_LETTER_SWEEP;
    }
  });

  async function makeDateDir(base: string, dateStr: string): Promise<string> {
    const dir = join(base, dateStr);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dummy.json"), "{}", "utf8");
    return dir;
  }

  test("removes directories older than retentionDays", async () => {
    const now = new Date("2024-06-15T12:00:00Z");
    // 35 days before now — should be swept (default 30 days).
    await makeDateDir(sweepBase, "2024-05-11");
    // 1 day before now — should be kept.
    await makeDateDir(sweepBase, "2024-06-14");

    await sweepDeadLetters({ baseDir: sweepBase, retentionDays: 30, now });

    const remaining = await readdir(sweepBase);
    expect(remaining).not.toContain("2024-05-11");
    expect(remaining).toContain("2024-06-14");
  });

  test("keeps directories exactly at the retention boundary", async () => {
    const now = new Date("2024-06-15T00:00:00Z");
    // Exactly 30 days before midnight UTC — right at the boundary; should be kept
    // because cutoff is strictly less-than.
    await makeDateDir(sweepBase, "2024-05-16");

    await sweepDeadLetters({ baseDir: sweepBase, retentionDays: 30, now });

    const remaining = await readdir(sweepBase);
    expect(remaining).toContain("2024-05-16");
  });

  test("ignores non-date entries in the base dir", async () => {
    // A file / dir that doesn't match YYYY-MM-DD should not be touched.
    await mkdir(join(sweepBase, "archive"), { recursive: true });
    await writeFile(join(sweepBase, "readme.txt"), "hello", "utf8");

    await sweepDeadLetters({ baseDir: sweepBase, retentionDays: 30 });

    const remaining = await readdir(sweepBase);
    expect(remaining).toContain("archive");
    expect(remaining).toContain("readme.txt");
  });

  test("is a no-op when the base directory does not exist", async () => {
    const nonExistent = join(sweepBase, "does-not-exist");
    await expect(
      sweepDeadLetters({ baseDir: nonExistent, retentionDays: 30 }),
    ).resolves.toBeUndefined();
  });

  test("respects DEAD_LETTER_SWEEP=false env var", async () => {
    const now = new Date("2024-06-15T12:00:00Z");
    await makeDateDir(sweepBase, "2024-05-01"); // old, should normally be swept

    // Explicitly disable the sweeper for this test.
    process.env.DEAD_LETTER_SWEEP = "false";

    await sweepDeadLetters({ baseDir: sweepBase, retentionDays: 30, now });

    // afterEach will restore the env; no manual restore needed here.
    const remaining = await readdir(sweepBase);
    expect(remaining).toContain("2024-05-01"); // not swept
  });
});

// ---------------------------------------------------------------------------
// Replay integration: use createWebhooks directly (no HTTP)
// ---------------------------------------------------------------------------

describe("dead-letter replay via handler", () => {
  test("replay drives stored payload through a test webhook handler", async () => {
    const { createWebhooks } = await import("../src/server/webhooks");
    const { buildAllowlist } = await import("../src/config/repos");
    const { createHmac } = await import("node:crypto");

    const SECRET = "replay-test-secret";
    const deliveryId = "dl-replay-001";
    const payload = JSON.stringify({
      action: "opened",
      number: 7,
      pull_request: { number: 7, head: { sha: "abcdef" } },
      repository: { full_name: "test/repo" },
      sender: { login: "tester" },
    });

    // Record received event to verify the handler was invoked.
    let receivedPayload: string | undefined;

    const webhooks = createWebhooks(SECRET, {
      allowlist: buildAllowlist({}),
      octokit: {} as never,
      anthropic: {} as never,
      selfLogin: "replay-bot",
    });

    // Attach a generic handler to capture raw reception.
    webhooks.onAny(({ payload: p }) => {
      receivedPayload = JSON.stringify(p);
    });

    const sig = `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;

    await webhooks.verifyAndReceive({
      id: deliveryId,
      name: "pull_request",
      signature: sig,
      payload,
    });

    expect(receivedPayload).toBeDefined();
    const parsed = JSON.parse(receivedPayload!);
    expect(parsed.number).toBe(7);
  });
});
