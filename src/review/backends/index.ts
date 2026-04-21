/**
 * Backend factory for LLM review calls.
 *
 * Reads `LLM_BACKEND` (default: `api`) and returns a singleton backend
 * instance.  Supported values:
 *   - `api`        — Anthropic REST API via `@anthropic-ai/sdk` (default).
 *   - `claude-cli` — Spawns the `claude` CLI (Max subscription, no API key).
 *
 * IMPORTANT: When `LLM_BACKEND=claude-cli`, this module runs a `claude
 * --version` health check at import time.  If the binary is missing or
 * returns a non-zero exit code, the process exits with code 1.  This is
 * intentional — a misconfigured backend at startup is safer than failing
 * every review at runtime.
 *
 * Known limitation: the `process.exit(1)` at import time can surprise test
 * runners if `LLM_BACKEND` is accidentally set to `claude-cli` in a test
 * environment where the binary is absent.  Guard your tests with
 * `LLM_BACKEND=api` (the default) or use the `getReviewBackendFactory`
 * escape hatch with a custom `checkVersion` hook.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { log } from "../../server/logger";
import { ApiBackend } from "./api";
import { ClaudeCliBackend, checkClaudeCliAvailable } from "./claude-cli";
import type { ReviewBackend } from "./types";
import type { SpawnFn } from "./claude-cli";

export type { ReviewBackend, BackendInvokeRequest, BackendInvokeResult, BackendUsage } from "./types";
export { ApiBackend } from "./api";
export { ClaudeCliBackend } from "./claude-cli";

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

let _apiBackend: ApiBackend | null = null;
let _cliBackend: ClaudeCliBackend | null = null;

/**
 * Returns the singleton backend selected by `LLM_BACKEND`.
 *
 * `anthropic` is required when `LLM_BACKEND=api` (or unset) so the API
 * backend can be constructed with the shared client.  It is ignored for the
 * `claude-cli` backend.
 */
export function getReviewBackend(anthropic?: Anthropic): ReviewBackend {
  const backendName = process.env["LLM_BACKEND"] ?? "api";

  if (backendName === "claude-cli") {
    if (!_cliBackend) {
      _cliBackend = new ClaudeCliBackend();
    }
    return _cliBackend;
  }

  // Default: api
  if (!_apiBackend) {
    if (!anthropic) {
      throw new Error(
        "getReviewBackend: an Anthropic client is required when LLM_BACKEND=api",
      );
    }
    _apiBackend = new ApiBackend(anthropic);
  } else if (anthropic) {
    // Caller is supplying a (potentially per-repo) client — create a fresh
    // ApiBackend wrapping that specific client.  The singleton is kept for
    // the default-client path.
    return new ApiBackend(anthropic);
  }

  return _apiBackend;
}

/**
 * Reset backend singletons.  Only for use in tests.
 */
export function _resetBackends(): void {
  _apiBackend = null;
  _cliBackend = null;
}

// ---------------------------------------------------------------------------
// Factory with injectable health-check hook (for testing)
// ---------------------------------------------------------------------------

export interface BackendFactoryOptions {
  /**
   * Override the health-check function (useful in tests to avoid spawning the
   * real `claude` binary).  Defaults to `checkClaudeCliAvailable`.
   */
  checkVersion?: (spawnFn?: SpawnFn) => Promise<{ ok: true } | { ok: false; reason: string }>;
  spawnFn?: SpawnFn;
}

/**
 * Creates a backend instance for the given `LLM_BACKEND` value, running the
 * availability check when selecting `claude-cli`.
 *
 * Unlike `getReviewBackend`, this is NOT a singleton path — it is used for
 * the boot-time check and by tests that need full control.
 *
 * Returns `null` if the backend is unavailable (caller should exit).
 */
export async function createBackend(
  backendName: string,
  anthropic: Anthropic | undefined,
  opts: BackendFactoryOptions = {},
): Promise<ReviewBackend | null> {
  if (backendName === "claude-cli") {
    const checkFn = opts.checkVersion ?? checkClaudeCliAvailable;
    const result = await checkFn(opts.spawnFn);
    if (!result.ok) {
      log.error("backend.unavailable", {
        evt: "backend.unavailable",
        backend: "claude-cli",
        reason: result.reason,
      });
      return null;
    }
    return new ClaudeCliBackend(opts.spawnFn);
  }

  if (!anthropic) {
    throw new Error("createBackend: Anthropic client required for api backend");
  }
  return new ApiBackend(anthropic);
}

// ---------------------------------------------------------------------------
// Boot-time health check for `claude-cli` backend
// ---------------------------------------------------------------------------

/**
 * Run the boot-time availability check when `LLM_BACKEND=claude-cli`.
 *
 * Called once at server startup (from `index.ts` or wherever the server is
 * initialised).  Logs an error and exits with code 1 if `claude` is missing.
 *
 * Deliberately separate from module-level side effects so test runners that
 * import this module without `LLM_BACKEND=claude-cli` are not affected.
 */
export async function runBootHealthCheck(): Promise<void> {
  const backendName = process.env["LLM_BACKEND"] ?? "api";
  if (backendName !== "claude-cli") return;

  const result = await checkClaudeCliAvailable();
  if (!result.ok) {
    log.error("backend.unavailable", {
      evt: "backend.unavailable",
      backend: "claude-cli",
      reason: result.reason,
    });
    process.exit(1);
  }

  // Log a one-time info message: per-repo key overrides are silently ignored
  // when using the CLI backend (Max subscription doesn't accept alternate keys).
  log.info("backend.selected", {
    evt: "backend.selected",
    backend: "claude-cli",
    note: "per-repo anthropic_api_key_env overrides are ignored in claude-cli mode",
  });
}
