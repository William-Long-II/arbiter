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
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "../server/logger";
import { redact } from "../util/redact";

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

  const record: AuditRecord = {
    ts: now.toISOString(),
    repo: input.repo,
    pr: input.pr,
    head_sha: input.headSha,
    mode: input.mode,
    // Redact secrets from all three text fields before writing.
    prompt_system: redact(input.promptSystem),
    prompt_user: redact(input.promptUser),
    response_raw: redact(input.responseRaw),
    usage: input.usage,
    verdict: input.verdict,
    warnings: input.warnings,
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
