/**
 * Prompt audit trail: persist built prompts and raw LLM responses to disk so
 * operators can diagnose unexpected review outputs without re-running live.
 *
 * Files land at: <AUDIT_LOG_DIR>/YYYY-MM-DD/<owner>__<repo>_<pr>_<headSha>.json
 * Default dir:   var/audit
 *
 * Set AUDIT_LOG_DIR=disabled to suppress all writes (e.g. in test environments
 * or when disk space is constrained).
 *
 * Secret redaction: promptSystem, promptUser, and responseRaw are passed
 * through redact() before writing, so no PATs or Anthropic keys end up on disk.
 *
 * Byte cap: set AUDIT_MAX_PROMPT_BYTES to cap each of promptSystem, promptUser,
 * and responseRaw to at most that many UTF-8 bytes. Truncation happens AFTER
 * secret redaction. When a field is truncated, a suffix is appended recording
 * the original byte count, and an optional boolean flag (e.g. promptSystemTruncated)
 * is added to the record. The cap is unset by default — no truncation occurs.
 *
 * Note: truncating prompts breaks replayability — operators cannot feed a
 * truncated prompt back into a new run. Use the cap only when disk pressure
 * outweighs that concern.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../server/logger";
import { redact } from "../util/redact";

// ---------------------------------------------------------------------------
// Byte-cap configuration (module-scoped, lazy-initialised on first write)
// ---------------------------------------------------------------------------

/** Result returned by truncateToBytes. */
type TruncateResult = {
  text: string;
  truncated: boolean;
  originalBytes: number;
};

/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes without splitting a multi-byte
 * codepoint. When truncation is needed, appends a human-readable suffix that
 * records the original byte count.
 *
 * Uses TextEncoder for accurate UTF-8 byte counting and TextDecoder for
 * safe reconstruction from the truncated byte slice.
 */
export function truncateToBytes(s: string, maxBytes: number): TruncateResult {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(s);
  const originalBytes = encoded.byteLength;

  if (originalBytes <= maxBytes) {
    return { text: s, truncated: false, originalBytes };
  }

  // The suffix itself costs bytes; reserve space for it.
  // We build the suffix first with the final originalBytes, then fit content.
  const suffix = `\n… [truncated, original ${originalBytes} bytes]`;
  const suffixBytes = encoder.encode(suffix).byteLength;
  const contentBudget = maxBytes - suffixBytes;

  if (contentBudget <= 0) {
    // Edge case: the suffix alone exceeds the cap. Return just the suffix
    // trimmed to maxBytes — at minimum the operator sees the truncation marker.
    const suffixEncoded = encoder.encode(suffix);
    const trimmed = suffixEncoded.slice(0, maxBytes);
    return {
      text: new TextDecoder().decode(trimmed),
      truncated: true,
      originalBytes,
    };
  }

  // Slice the encoded bytes to contentBudget and decode. TextDecoder with
  // fatal:false will replace any partial codepoint at the boundary with the
  // Unicode replacement character, which we then trim to keep output clean.
  const contentSlice = encoded.slice(0, contentBudget);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  // Trim any replacement character inserted for a partial codepoint.
  const contentText = decoder.decode(contentSlice).replace(/\uFFFD$/, "");

  return { text: contentText + suffix, truncated: true, originalBytes };
}

/** Parsed value of AUDIT_MAX_PROMPT_BYTES, or undefined when unset/invalid. */
let _capBytes: number | undefined;
/** Whether the module-init log has been emitted. */
let _hasLoggedCap = false;

/**
 * Reset the module-level cap cache. Exported for test use only — allows tests
 * to change AUDIT_MAX_PROMPT_BYTES between cases without module reload.
 * @internal
 */
export function _resetCapCache(): void {
  _capBytes = undefined;
  _hasLoggedCap = false;
}

/** Read and validate the cap env var. Called lazily on first write. */
function getCapBytes(): number | undefined {
  if (_capBytes !== undefined) return _capBytes;

  const raw = process.env.AUDIT_MAX_PROMPT_BYTES;
  if (!raw) return undefined;

  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;

  _capBytes = n;

  if (!_hasLoggedCap) {
    _hasLoggedCap = true;
    log.info("audit.cap_configured", { bytes: n });
  }

  return _capBytes;
}

/**
 * Apply the byte cap to a string field if configured.
 * Returns the (possibly truncated) string and a flag indicating truncation.
 */
function applyCapToString(
  s: string,
  capBytes: number | undefined,
): { value: string; wasTruncated: boolean } {
  if (capBytes === undefined) return { value: s, wasTruncated: false };
  const result = truncateToBytes(s, capBytes);
  return { value: result.text, wasTruncated: result.truncated };
}

/**
 * Apply the byte cap to an unknown field. Non-string values are JSON-serialised
 * before truncation and stored as the truncated string. If no cap is set, the
 * original value is returned unchanged.
 */
function applyCapToUnknown(
  v: unknown,
  capBytes: number | undefined,
): { value: unknown; wasTruncated: boolean } {
  if (capBytes === undefined) return { value: v, wasTruncated: false };
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const result = truncateToBytes(s, capBytes);
  return { value: result.text, wasTruncated: result.truncated };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AuditMode =
  | "single"
  | "chunked-pass-1"
  | "chunked-pass-2";

export type AuditRecord = {
  ts: string;
  repo: string;
  pr: number;
  head_sha: string;
  mode: AuditMode;
  prompt_system: unknown;
  prompt_user: unknown;
  response_raw: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  } | undefined;
  verdict: string | undefined;
  warnings: string[];
  /** Present and true only when the field was truncated by AUDIT_MAX_PROMPT_BYTES. */
  promptSystemTruncated?: boolean;
  /** Present and true only when the field was truncated by AUDIT_MAX_PROMPT_BYTES. */
  promptUserTruncated?: boolean;
  /** Present and true only when the field was truncated by AUDIT_MAX_PROMPT_BYTES. */
  responseRawTruncated?: boolean;
};

export type WriteAuditRecordInput = {
  repo: string;
  pr: number;
  headSha: string;
  mode: AuditMode;
  promptSystem: string;
  promptUser: string;
  responseRaw: unknown;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  verdict?: string;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAuditLogDir(): string {
  return process.env.AUDIT_LOG_DIR ?? "var/audit";
}

function getRetentionDays(): number {
  const val = process.env.AUDIT_RETENTION_DAYS;
  if (!val) return 7;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

function dateDir(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Convert "owner/name" to "owner__name" for use in a filesystem path. */
function slugRepo(repo: string): string {
  return repo.replace("/", "__");
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Persist one audit record for a completed LLM call.
 * Never throws — write failures are logged but do not affect the review result.
 */
export async function writeAuditRecord(
  input: WriteAuditRecordInput,
): Promise<void> {
  const dir = getAuditLogDir();

  // The disabled sentinel suppresses all writes without error.
  if (dir === "disabled") return;

  const now = new Date();
  const dateStr = dateDir(now);
  const dirPath = join(dir, dateStr);
  const slug = slugRepo(input.repo);
  // Include the mode in the file name so chunked pass-1 and pass-2 are stored
  // as distinct files rather than overwriting each other.
  const fileName = `${slug}_${input.pr}_${input.headSha}_${input.mode}.json`;
  const filePath = join(dirPath, fileName);

  // Redact secrets first, then apply the byte cap (redact-then-truncate order
  // ensures secrets are never preserved via the truncation suffix).
  const redactedSystem = redact(input.promptSystem) as string;
  const redactedUser = redact(input.promptUser) as string;
  const redactedResponse = redact(input.responseRaw);

  const capBytes = getCapBytes();

  const { value: cappedSystem, wasTruncated: systemTruncated } =
    applyCapToString(redactedSystem, capBytes);
  const { value: cappedUser, wasTruncated: userTruncated } =
    applyCapToString(redactedUser, capBytes);
  const { value: cappedResponse, wasTruncated: responseTruncated } =
    applyCapToUnknown(redactedResponse, capBytes);

  const record: AuditRecord = {
    ts: now.toISOString(),
    repo: input.repo,
    pr: input.pr,
    head_sha: input.headSha,
    mode: input.mode,
    prompt_system: cappedSystem,
    prompt_user: cappedUser,
    response_raw: cappedResponse,
    usage: input.usage,
    verdict: input.verdict,
    warnings: input.warnings,
    // Omit truncation flags when false to keep audit files forward-compatible.
    ...(systemTruncated && { promptSystemTruncated: true }),
    ...(userTruncated && { promptUserTruncated: true }),
    ...(responseTruncated && { responseRawTruncated: true }),
  };

  try {
    await mkdir(dirPath, { recursive: true });
    await writeFile(filePath, JSON.stringify(record, null, 2) + "\n", {
      encoding: "utf8",
      // Use "w" (overwrite) rather than "wx" (fail-if-exists) because chunked
      // reviews write pass-1 and pass-2 records to different files (different
      // modes are typically in the same run; same headSha + same pr). However,
      // if a retry produces the same parameters, overwriting is safer than
      // leaving a stale record.
      flag: "w",
    });
    log.info("audit record written", {
      repo: input.repo,
      pr: input.pr,
      headSha: input.headSha,
      mode: input.mode,
      path: filePath,
    });
  } catch (writeErr: unknown) {
    log.error("failed to write audit record", {
      repo: input.repo,
      pr: input.pr,
      headSha: input.headSha,
      mode: input.mode,
      path: filePath,
      error: writeErr instanceof Error ? writeErr.message : String(writeErr),
    });
  }
}

// ---------------------------------------------------------------------------
// Retention sweeper
// ---------------------------------------------------------------------------

/**
 * Delete date-directories older than AUDIT_RETENTION_DAYS (default 7).
 * Called once at process start alongside sweepDeadLetters().
 */
export async function sweepAudit(
  options: {
    baseDir?: string;
    retentionDays?: number;
    now?: Date;
  } = {},
): Promise<void> {
  const baseDir = options.baseDir ?? getAuditLogDir();

  // Respect the disabled sentinel in the sweeper as well.
  if (baseDir === "disabled") return;

  const retentionDays = options.retentionDays ?? getRetentionDays();
  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // nothing written yet
    log.error("audit sweep: failed to list dir", {
      baseDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const entry of entries) {
    // Only touch YYYY-MM-DD directories.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry)) continue;
    const entryMs = new Date(entry + "T00:00:00Z").getTime();
    if (Number.isNaN(entryMs)) continue;
    if (entryMs < cutoffMs) {
      try {
        await rm(join(baseDir, entry), { recursive: true, force: true });
        log.info("audit sweep: removed old dir", {
          dir: entry,
          retentionDays,
        });
      } catch (rmErr: unknown) {
        log.error("audit sweep: failed to remove dir", {
          dir: entry,
          error: rmErr instanceof Error ? rmErr.message : String(rmErr),
        });
      }
    }
  }
}
