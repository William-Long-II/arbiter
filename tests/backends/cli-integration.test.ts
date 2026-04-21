/**
 * Integration test for the ClaudeCliBackend end-to-end path.
 *
 * Uses a stub `claude` shell script at tests/fixtures/bin/claude that echoes
 * a canned JSON response. Rather than mutating PATH (which doesn't propagate
 * to Bun.spawn reliably), we inject a SpawnFn that rewrites the command's
 * first argument from "claude" to the stub's absolute path. This proves the
 * backend's subprocess orchestration + envelope parsing without touching PATH.
 *
 * Skipped on Windows — the fixture is a POSIX shell script.
 */

import { describe, test, expect } from "bun:test";
import path from "node:path";
import {
  ClaudeCliBackend,
  checkClaudeCliAvailable,
  type SpawnFn,
} from "../../src/review/backends/claude-cli";
import { ReviewResultSchema } from "../../src/review/schema";

const isWindows = process.platform === "win32";

// Absolute path to the stub. Bun.spawn on POSIX will execute it directly when
// given this path; the shebang selects /usr/bin/env sh.
const STUB_CLAUDE = path.resolve(
  import.meta.dir,
  "../fixtures/bin/claude",
);

/**
 * Wraps the real Bun.spawn but rewrites "claude" → STUB_CLAUDE.
 * Everything else about the call — stdin/stdout/stderr pipes, exit code
 * surfacing, promise lifecycle — is exercised unchanged.
 */
const stubSpawn: SpawnFn = (cmd, _opts) => {
  const rewritten = cmd[0] === "claude" ? [STUB_CLAUDE, ...cmd.slice(1)] : cmd;
  const proc = Bun.spawn(rewritten, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: { text: () => new Response(proc.stdout).text() },
    stderr: { text: () => new Response(proc.stderr).text() },
    exited: proc.exited,
  };
};

describe("ClaudeCliBackend integration (stub binary)", () => {
  test.skipIf(isWindows)(
    "full review pipeline produces a correctly-shaped result",
    async () => {
      const backend = new ClaudeCliBackend(stubSpawn);

      const result = await backend.parseReview({
        system: "You are a reviewer.",
        userMessage: "Review this change.",
        schema: ReviewResultSchema,
        model: "claude-opus-4-7",
        maxTokens: 16000,
        repo: "acme/widget",
        pr: 1,
      });

      expect(result.parsedOutput.verdict).toBe("approve");
      expect(typeof result.parsedOutput.summary).toBe("string");
      expect(result.parsedOutput.summary.length).toBeGreaterThan(0);
      expect(Array.isArray(result.parsedOutput.lineComments)).toBe(true);

      expect(result.usage.input_tokens).toBe(42);
      expect(result.usage.output_tokens).toBe(18);
      expect(result.usage.cache_read_input_tokens).toBe(0);
      expect(result.usage.cache_creation_input_tokens).toBe(0);
    },
  );

  test.skipIf(isWindows)(
    "version check succeeds against the stub binary",
    async () => {
      const result = await checkClaudeCliAvailable(stubSpawn);
      expect(result.ok).toBe(true);
    },
  );
});
