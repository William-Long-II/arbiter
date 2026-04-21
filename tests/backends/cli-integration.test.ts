/**
 * Integration test for the ClaudeCliBackend end-to-end path.
 *
 * Uses a stub `claude` shell script in tests/fixtures/bin/ that echoes a
 * canned JSON response.  The test prepends that directory to PATH so the
 * real `claude` binary (if present) is not invoked.
 *
 * This test only runs on Unix-like systems where the fixture shell script
 * can be executed.  On Windows it is skipped gracefully.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import path from "node:path";
import { ClaudeCliBackend } from "../../src/review/backends/claude-cli";
import { ReviewResultSchema } from "../../src/review/schema";

const isWindows = process.platform === "win32";

// The fixture bin directory containing the stub `claude` script.
const FIXTURE_BIN = path.resolve(
  import.meta.dir,
  "../fixtures/bin",
);

describe("ClaudeCliBackend integration (stub binary)", () => {
  // Override PATH so the stub is found first.
  const savedPath = process.env["PATH"] ?? "";

  beforeAll(() => {
    if (!isWindows) {
      process.env["PATH"] = `${FIXTURE_BIN}:${savedPath}`;
    }
  });

  test.skipIf(isWindows)("full review pipeline produces a correctly-shaped result", async () => {
    // Use Bun.spawn directly via the default spawn (no injection needed since
    // PATH now points to the stub).
    const backend = new ClaudeCliBackend();

    const result = await backend.parseReview({
      system: "You are a reviewer.",
      userMessage: "Review this change.",
      schema: ReviewResultSchema,
      model: "claude-opus-4-7",
      maxTokens: 16000,
      repo: "acme/widget",
      pr: 1,
    });

    // Shape assertions
    expect(result.parsedOutput.verdict).toBe("approve");
    expect(typeof result.parsedOutput.summary).toBe("string");
    expect(result.parsedOutput.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(result.parsedOutput.lineComments)).toBe(true);

    // Usage is reported (stub emits concrete values)
    expect(result.usage.input_tokens).toBe(42);
    expect(result.usage.output_tokens).toBe(18);
    expect(result.usage.cache_read_input_tokens).toBe(0);
    expect(result.usage.cache_creation_input_tokens).toBe(0);
  });

  test.skipIf(isWindows)("version check succeeds with stub binary in PATH", async () => {
    const { checkClaudeCliAvailable } = await import("../../src/review/backends/claude-cli");
    const result = await checkClaudeCliAvailable();
    expect(result.ok).toBe(true);
  });
});
