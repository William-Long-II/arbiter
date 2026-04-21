/**
 * Tests for AUDIT_MAX_PROMPT_BYTES byte-cap feature in writeAuditRecord.
 *
 * Covers:
 *  1. Cap set → fields truncated, flags present, suffix correct.
 *  2. Cap unset → no truncation, no flags.
 *  3. Redact-then-truncate ordering: PAT is redacted before cap is applied.
 *  4. UTF-8 boundary safety: multi-byte chars near the cap produce valid output.
 *  5. truncateToBytes unit tests (pure helper, no I/O).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  _resetCapCache,
  truncateToBytes,
  writeAuditRecord,
} from "../src/review/audit";
import type { AuditRecord } from "../src/review/audit";

// ---------------------------------------------------------------------------
// Shared temp directory
// ---------------------------------------------------------------------------

const BASE_DIR = join(
  import.meta.dir,
  "..",
  "var",
  "test-audit-cap",
  `run-${Date.now()}`,
);

beforeAll(async () => {
  await mkdir(BASE_DIR, { recursive: true });
  process.env.AUDIT_LOG_DIR = BASE_DIR;
});

afterAll(async () => {
  delete process.env.AUDIT_LOG_DIR;
  delete process.env.AUDIT_MAX_PROMPT_BYTES;
  _resetCapCache();
  await rm(BASE_DIR, { recursive: true, force: true });
});

afterEach(() => {
  // Reset module-level cap cache so each test reads the env var fresh.
  delete process.env.AUDIT_MAX_PROMPT_BYTES;
  _resetCapCache();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readAuditFile(slug: string): Promise<{ raw: string; record: AuditRecord }> {
  const dateDirs = (await readdir(BASE_DIR)).filter((d) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d),
  );
  dateDirs.sort();
  const todayDir = dateDirs[dateDirs.length - 1]!;
  const files = await readdir(join(BASE_DIR, todayDir));
  const match = files.find((f) => f.includes(slug));
  if (!match) throw new Error(`No audit file found for slug: ${slug}`);
  const raw = await readFile(join(BASE_DIR, todayDir, match), "utf8");
  return { raw, record: JSON.parse(raw) as AuditRecord };
}

// ---------------------------------------------------------------------------
// truncateToBytes — pure unit tests
// ---------------------------------------------------------------------------

describe("truncateToBytes — unit", () => {
  test("returns original string unchanged when under the cap", () => {
    const s = "hello world";
    const result = truncateToBytes(s, 1000);
    expect(result.text).toBe(s);
    expect(result.truncated).toBe(false);
    expect(result.originalBytes).toBe(new TextEncoder().encode(s).byteLength);
  });

  test("returns original string unchanged when exactly at the cap", () => {
    const s = "abc"; // 3 bytes
    const result = truncateToBytes(s, 3);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(s);
  });

  test("truncates and appends suffix when over the cap", () => {
    const s = "A".repeat(5000); // 5000 bytes
    const cap = 1000;
    const result = truncateToBytes(s, cap);
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(5000);
    // The output must fit within the cap in UTF-8.
    const outputBytes = new TextEncoder().encode(result.text).byteLength;
    expect(outputBytes).toBeLessThanOrEqual(cap);
    // Suffix must be present.
    expect(result.text).toContain("[truncated, original 5000 bytes]");
  });

  test("suffix contains the correct original byte count", () => {
    const s = "X".repeat(2000);
    const result = truncateToBytes(s, 500);
    expect(result.text).toContain("original 2000 bytes");
  });

  test("UTF-8 boundary: multi-byte chars do not produce partial codepoints", () => {
    // "é" (U+00E9) is 2 bytes in UTF-8. Build a string that puts a 2-byte char
    // right at the slice boundary.
    const multiByte = "é".repeat(300); // 600 bytes
    const cap = 101; // odd number so a 2-byte char straddles the boundary
    const result = truncateToBytes(multiByte, cap);

    // Validate the output is valid UTF-8 by encoding/decoding it.
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    // fatal:true throws on invalid sequences — this assertion would throw if broken.
    expect(() => decoder.decode(encoder.encode(result.text))).not.toThrow();
    expect(result.truncated).toBe(true);
  });

  test("output bytes do not exceed cap even with multi-byte content", () => {
    // CJK characters are 3 bytes each in UTF-8.
    const cjk = "中".repeat(500); // 1500 bytes
    const cap = 200;
    const result = truncateToBytes(cjk, cap);
    const outputBytes = new TextEncoder().encode(result.text).byteLength;
    expect(outputBytes).toBeLessThanOrEqual(cap);
    expect(result.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeAuditRecord — cap active (cap = 1000, prompt = 5000 bytes)
// ---------------------------------------------------------------------------

describe("writeAuditRecord — cap active", () => {
  beforeEach(() => {
    process.env.AUDIT_MAX_PROMPT_BYTES = "1000";
    _resetCapCache();
  });

  test("truncates promptUser and sets promptUserTruncated flag", async () => {
    const longUser = "U".repeat(5000);
    await writeAuditRecord({
      repo: "acme/cap-active",
      pr: 200,
      headSha: "cap0001",
      mode: "single",
      promptSystem: "short system",
      promptUser: longUser,
      responseRaw: "short response",
      usage: { inputTokens: 1, outputTokens: 1 },
      verdict: "approve",
      warnings: [],
    });

    const { record } = await readAuditFile("cap0001");

    // promptUser must be truncated.
    expect(record.promptUserTruncated).toBe(true);
    expect(typeof record.prompt_user).toBe("string");
    const userBytes = new TextEncoder().encode(record.prompt_user as string).byteLength;
    expect(userBytes).toBeLessThanOrEqual(1000);
    expect(record.prompt_user as string).toContain("[truncated, original 5000 bytes]");

    // promptSystem was short — no truncation flag.
    expect(record.promptSystemTruncated).toBeUndefined();
    // responseRaw was short — no truncation flag.
    expect(record.responseRawTruncated).toBeUndefined();
  });

  test("truncates promptSystem and responseRaw independently", async () => {
    const longSystem = "S".repeat(5000);
    const longResponse = "R".repeat(5000);
    await writeAuditRecord({
      repo: "acme/cap-active",
      pr: 201,
      headSha: "cap0002",
      mode: "single",
      promptSystem: longSystem,
      promptUser: "short user",
      responseRaw: longResponse,
      usage: { inputTokens: 1, outputTokens: 1 },
      verdict: "approve",
      warnings: [],
    });

    const { record } = await readAuditFile("cap0002");

    expect(record.promptSystemTruncated).toBe(true);
    expect(record.promptUserTruncated).toBeUndefined();
    expect(record.responseRawTruncated).toBe(true);

    const sysBytes = new TextEncoder().encode(record.prompt_system as string).byteLength;
    expect(sysBytes).toBeLessThanOrEqual(1000);
    const respBytes = new TextEncoder().encode(record.response_raw as string).byteLength;
    expect(respBytes).toBeLessThanOrEqual(1000);
  });
});

// ---------------------------------------------------------------------------
// writeAuditRecord — cap unset
// ---------------------------------------------------------------------------

describe("writeAuditRecord — cap unset", () => {
  test("no truncation, no *Truncated flags when cap is not configured", async () => {
    // Ensure cap env var is not set.
    delete process.env.AUDIT_MAX_PROMPT_BYTES;
    _resetCapCache();

    const mediumUser = "U".repeat(3000);
    await writeAuditRecord({
      repo: "acme/cap-unset",
      pr: 300,
      headSha: "noc0001",
      mode: "single",
      promptSystem: "system text",
      promptUser: mediumUser,
      responseRaw: "response text",
      usage: { inputTokens: 1, outputTokens: 1 },
      verdict: "approve",
      warnings: [],
    });

    const { record } = await readAuditFile("noc0001");

    // Full content preserved.
    expect(record.prompt_user).toBe(mediumUser);
    // No truncation flags present.
    expect(record.promptSystemTruncated).toBeUndefined();
    expect(record.promptUserTruncated).toBeUndefined();
    expect(record.responseRawTruncated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// writeAuditRecord — redact-then-truncate order
// ---------------------------------------------------------------------------

describe("writeAuditRecord — redact-then-truncate ordering", () => {
  test("PAT is redacted before the byte cap is applied", async () => {
    process.env.AUDIT_MAX_PROMPT_BYTES = "500";
    _resetCapCache();

    // Build a 3000-byte prompt that contains a PAT token in the middle.
    const fakePat = "ghp_" + "B".repeat(36); // 40 chars, matches GH_TOKEN pattern
    const padding = "P".repeat(1480);
    // total: 1480 + fakePat.length + 1480 ≈ 3000 bytes
    const promptUser = padding + fakePat + padding;

    await writeAuditRecord({
      repo: "acme/redact-order",
      pr: 400,
      headSha: "rdo0001",
      mode: "single",
      promptSystem: "short",
      promptUser,
      responseRaw: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
      verdict: "approve",
      warnings: [],
    });

    const { raw, record } = await readAuditFile("rdo0001");

    // The PAT must never appear anywhere in the file.
    expect(raw).not.toContain(fakePat);

    // Truncation should have happened (3000 > 500).
    expect(record.promptUserTruncated).toBe(true);

    // The truncation suffix must be present.
    expect(record.prompt_user as string).toContain("[truncated,");

    // The stored value must be within the cap.
    const userBytes = new TextEncoder().encode(record.prompt_user as string).byteLength;
    expect(userBytes).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// writeAuditRecord — UTF-8 boundary safety in full write path
// ---------------------------------------------------------------------------

describe("writeAuditRecord — UTF-8 boundary in full write path", () => {
  test("stored prompt_user has no partial codepoints near the cap boundary", async () => {
    process.env.AUDIT_MAX_PROMPT_BYTES = "101";
    _resetCapCache();

    // "é" is 2 bytes; 300 of them = 600 bytes — well over the 101-byte cap.
    const promptUser = "é".repeat(300);

    await writeAuditRecord({
      repo: "acme/utf8-boundary",
      pr: 500,
      headSha: "utf0001",
      mode: "single",
      promptSystem: "short",
      promptUser,
      responseRaw: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
      verdict: "approve",
      warnings: [],
    });

    const { record } = await readAuditFile("utf0001");

    // Verify the stored string is valid UTF-8 by re-encoding and decoding with fatal.
    const stored = record.prompt_user as string;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    expect(() => decoder.decode(encoder.encode(stored))).not.toThrow();
    expect(record.promptUserTruncated).toBe(true);

    // Output must not exceed the cap in bytes.
    const outBytes = encoder.encode(stored).byteLength;
    expect(outBytes).toBeLessThanOrEqual(101);
  });
});
