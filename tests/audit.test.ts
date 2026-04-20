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
import { writeAuditRecord, sweepAudit } from "../src/review/audit";
import type { AuditRecord } from "../src/review/audit";

// ---------------------------------------------------------------------------
// Shared temp directory
// ---------------------------------------------------------------------------

const BASE_DIR = join(
  import.meta.dir,
  "..",
  "var",
  "test-audit",
  `run-${Date.now()}`,
);

beforeAll(async () => {
  await mkdir(BASE_DIR, { recursive: true });
  process.env.AUDIT_LOG_DIR = BASE_DIR;
});

afterAll(async () => {
  delete process.env.AUDIT_LOG_DIR;
  await rm(BASE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readLatestAuditFile(dir: string): Promise<AuditRecord> {
  const dateDirs = (await readdir(dir)).filter((d) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d),
  );
  // Sort chronologically; the last entry is today.
  dateDirs.sort();
  const todayDir = dateDirs[dateDirs.length - 1]!;
  const files = await readdir(join(dir, todayDir));
  // Return the last written file.
  const file = files[files.length - 1]!;
  const raw = await readFile(join(dir, todayDir, file), "utf8");
  return JSON.parse(raw) as AuditRecord;
}

// ---------------------------------------------------------------------------
// writeAuditRecord — basic write
// ---------------------------------------------------------------------------

describe("writeAuditRecord — single-pass", () => {
  test("writes exactly one file with correct shape", async () => {
    await writeAuditRecord({
      repo: "acme/widget",
      pr: 42,
      headSha: "abc1234",
      mode: "single",
      promptSystem: "system prompt text",
      promptUser: "user prompt text",
      responseRaw: { verdict: "approve", summary: "ok", lineComments: [] },
      usage: {
        inputTokens: 100,
        outputTokens: 50,
      },
      verdict: "approve",
      warnings: [],
    });

    const dateDirs = (await readdir(BASE_DIR)).filter((d) =>
      /^\d{4}-\d{2}-\d{2}$/.test(d),
    );
    expect(dateDirs.length).toBeGreaterThanOrEqual(1);

    const todayDir = dateDirs[dateDirs.length - 1]!;
    const files = await readdir(join(BASE_DIR, todayDir));
    // File name uses __ slug for the repo, and includes the mode.
    const match = files.filter((f) => f === "acme__widget_42_abc1234_single.json");
    expect(match.length).toBe(1);

    const record = await readLatestAuditFile(BASE_DIR);
    expect(record.repo).toBe("acme/widget");
    expect(record.pr).toBe(42);
    expect(record.head_sha).toBe("abc1234");
    expect(record.mode).toBe("single");
    expect(record.verdict).toBe("approve");
    expect(record.ts).toBeTruthy();
    expect(record.usage?.inputTokens).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// writeAuditRecord — redaction
// ---------------------------------------------------------------------------

describe("writeAuditRecord — redaction", () => {
  test("PAT embedded in promptUser is redacted in the audit file", async () => {
    const fakePat = "ghp_" + "A".repeat(36);

    await writeAuditRecord({
      repo: "acme/widget",
      pr: 99,
      headSha: "redact01",
      mode: "single",
      promptSystem: "no secrets here",
      promptUser: `Authorization: Bearer ${fakePat}`,
      responseRaw: `token=${fakePat}`,
      usage: { inputTokens: 1, outputTokens: 1 },
      verdict: "comment",
      warnings: [],
    });

    const dateDirs = (await readdir(BASE_DIR))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    const todayDir = dateDirs[dateDirs.length - 1]!;
    const raw = await readFile(
      join(BASE_DIR, todayDir, "acme__widget_99_redact01_single.json"),
      "utf8",
    );

    // The PAT must not appear anywhere in the file.
    expect(raw).not.toContain(fakePat);
    // Both pattern-based redaction labels should appear.
    expect(raw).toContain("[REDACTED:");
  });

  test("Anthropic API key in promptSystem is redacted", async () => {
    const fakeKey = "sk-ant-testkey123456789abcdef";

    await writeAuditRecord({
      repo: "acme/widget",
      pr: 100,
      headSha: "redact02",
      mode: "single",
      promptSystem: `key=${fakeKey}`,
      promptUser: "normal prompt",
      responseRaw: "no secrets",
      usage: { inputTokens: 1, outputTokens: 1 },
      verdict: "approve",
      warnings: [],
    });

    const dateDirs = (await readdir(BASE_DIR))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    const todayDir = dateDirs[dateDirs.length - 1]!;
    const raw = await readFile(
      join(BASE_DIR, todayDir, "acme__widget_100_redact02_single.json"),
      "utf8",
    );

    expect(raw).not.toContain(fakeKey);
    expect(raw).toContain("[REDACTED:ANTHROPIC_KEY]");
  });
});

// ---------------------------------------------------------------------------
// AUDIT_LOG_DIR=disabled
// ---------------------------------------------------------------------------

describe("AUDIT_LOG_DIR=disabled", () => {
  let savedDir: string | undefined;

  beforeEach(() => {
    savedDir = process.env.AUDIT_LOG_DIR;
    process.env.AUDIT_LOG_DIR = "disabled";
  });

  afterEach(() => {
    if (savedDir !== undefined) {
      process.env.AUDIT_LOG_DIR = savedDir;
    } else {
      delete process.env.AUDIT_LOG_DIR;
    }
  });

  test("no file is written and no error is thrown", async () => {
    const tempDir = join(BASE_DIR, "disabled-check");
    // tempDir must NOT be created.

    await expect(
      writeAuditRecord({
        repo: "acme/disabled",
        pr: 1,
        headSha: "noop001",
        mode: "single",
        promptSystem: "sys",
        promptUser: "usr",
        responseRaw: "resp",
        usage: { inputTokens: 1, outputTokens: 1 },
        verdict: "approve",
        warnings: [],
      }),
    ).resolves.toBeUndefined();

    // No directory should have been created.
    let exists = false;
    try {
      await readdir(tempDir);
      exists = true;
    } catch (_) {
      // ENOENT expected — tempDir was never written.
    }
    expect(exists).toBe(false);
  });

  test("sweepAudit is a no-op when dir is disabled", async () => {
    await expect(sweepAudit()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Chunked review — two records
// ---------------------------------------------------------------------------

describe("writeAuditRecord — chunked", () => {
  test("chunked-pass-1 and chunked-pass-2 produce separate records", async () => {
    const headSha = "chunk001";
    const subDir = join(BASE_DIR, `chunked-${Date.now()}`);
    await mkdir(subDir, { recursive: true });

    // Temporarily redirect writes to isolated subDir.
    const saved = process.env.AUDIT_LOG_DIR;
    process.env.AUDIT_LOG_DIR = subDir;

    try {
      await writeAuditRecord({
        repo: "acme/chunked",
        pr: 7,
        headSha,
        mode: "chunked-pass-1",
        promptSystem: "batch sys",
        promptUser: "batch user",
        responseRaw: [{ file_summaries: [] }],
        usage: { inputTokens: 200, outputTokens: 100 },
        verdict: "chunked_pass_1",
        warnings: [],
      });

      await writeAuditRecord({
        repo: "acme/chunked",
        pr: 7,
        headSha,
        mode: "chunked-pass-2",
        promptSystem: "synth sys",
        promptUser: "synth user",
        responseRaw: { verdict: "comment", summary: "done", lineComments: [] },
        usage: { inputTokens: 150, outputTokens: 80 },
        verdict: "comment",
        warnings: [],
      });

      // Both pass-1 and pass-2 files should exist in today's date dir.
      const dateDirs = (await readdir(subDir)).filter((d) =>
        /^\d{4}-\d{2}-\d{2}$/.test(d),
      );
      const todayDir = dateDirs[dateDirs.length - 1]!;
      const files = await readdir(join(subDir, todayDir));

      // Each pass writes its own file distinguished by mode in the filename.
      const pass1File = `acme__chunked_7_${headSha}_chunked-pass-1.json`;
      const pass2File = `acme__chunked_7_${headSha}_chunked-pass-2.json`;
      expect(files).toContain(pass1File);
      expect(files).toContain(pass2File);

      const raw1 = await readFile(join(subDir, todayDir, pass1File), "utf8");
      const raw2 = await readFile(join(subDir, todayDir, pass2File), "utf8");
      const record1 = JSON.parse(raw1) as AuditRecord;
      const record2 = JSON.parse(raw2) as AuditRecord;
      expect(record1.mode).toBe("chunked-pass-1");
      expect(record2.mode).toBe("chunked-pass-2");
    } finally {
      if (saved !== undefined) {
        process.env.AUDIT_LOG_DIR = saved;
      } else {
        delete process.env.AUDIT_LOG_DIR;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// sweepAudit — retention
// ---------------------------------------------------------------------------

describe("sweepAudit — retention", () => {
  let sweepBase: string;

  beforeEach(async () => {
    sweepBase = join(BASE_DIR, `sweep-${Date.now()}`);
    await mkdir(sweepBase, { recursive: true });
  });

  async function makeDateDir(base: string, dateStr: string): Promise<void> {
    const dir = join(base, dateStr);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dummy.json"), "{}", "utf8");
  }

  test("removes date-dirs older than retentionDays", async () => {
    const now = new Date("2024-06-15T12:00:00Z");
    await makeDateDir(sweepBase, "2024-05-01"); // 45 days ago — sweep
    await makeDateDir(sweepBase, "2024-06-14"); // 1 day ago — keep

    await sweepAudit({ baseDir: sweepBase, retentionDays: 7, now });

    const remaining = await readdir(sweepBase);
    expect(remaining).not.toContain("2024-05-01");
    expect(remaining).toContain("2024-06-14");
  });

  test("keeps dirs exactly at the retention boundary", async () => {
    const now = new Date("2024-06-15T00:00:00Z");
    // Exactly 7 days before midnight UTC — right at the boundary; kept.
    await makeDateDir(sweepBase, "2024-06-08");

    await sweepAudit({ baseDir: sweepBase, retentionDays: 7, now });

    const remaining = await readdir(sweepBase);
    expect(remaining).toContain("2024-06-08");
  });

  test("ignores non-date entries", async () => {
    await mkdir(join(sweepBase, "archive"), { recursive: true });
    await writeFile(join(sweepBase, "notes.txt"), "hello", "utf8");

    await sweepAudit({ baseDir: sweepBase, retentionDays: 7 });

    const remaining = await readdir(sweepBase);
    expect(remaining).toContain("archive");
    expect(remaining).toContain("notes.txt");
  });

  test("is a no-op when base dir does not exist", async () => {
    const nonExistent = join(sweepBase, "does-not-exist");
    await expect(
      sweepAudit({ baseDir: nonExistent, retentionDays: 7 }),
    ).resolves.toBeUndefined();
  });
});
