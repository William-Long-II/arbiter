/**
 * Dead-letter log: persists webhook events that exhaust the handler so operators
 * can diagnose failures and replay them later.
 *
 * Files land at: <DEAD_LETTER_DIR>/YYYY-MM-DD/<delivery-id>.json
 * Default dir:   var/dead-letter
 *
 * Signature headers (x-hub-signature, x-hub-signature-256) are stripped before
 * writing so the stored file does not contain secrets.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DeadLetterEntry = {
  delivery_id: string;
  event: string;
  headers: Record<string, string>;
  payload: string;
  error: { message: string; stack?: string };
  attempts: number;
  written_at: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDeadLetterDir(): string {
  return process.env.DEAD_LETTER_DIR ?? "var/dead-letter";
}

function getRetentionDays(): number {
  const val = process.env.DEAD_LETTER_RETENTION_DAYS;
  if (!val) return 30;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** Strip signature headers so secrets are not persisted on disk. */
function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === "x-hub-signature" || lower === "x-hub-signature-256") {
      continue;
    }
    out[k] = v;
  }
  return out;
}

function dateDir(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Persist a failed webhook event to the dead-letter store.
 * Signature headers are stripped; never throws — failures are logged.
 */
export async function writeDeadLetter(opts: {
  delivery_id: string;
  event: string;
  headers: Record<string, string>;
  payload: string;
  error: unknown;
  attempts: number;
}): Promise<void> {
  const now = new Date();
  const dir = join(getDeadLetterDir(), dateDir(now));

  const err =
    opts.error instanceof Error
      ? { message: opts.error.message, stack: opts.error.stack }
      : { message: String(opts.error) };

  const entry: DeadLetterEntry = {
    delivery_id: opts.delivery_id,
    event: opts.event,
    headers: redactHeaders(opts.headers),
    payload: opts.payload,
    error: err,
    attempts: opts.attempts,
    written_at: now.toISOString(),
  };

  const filePath = join(dir, `${opts.delivery_id}.json`);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, JSON.stringify(entry, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx", // fail if the file already exists (idempotency guard)
    });
    log.info("dead letter written", {
      deliveryId: opts.delivery_id,
      event: opts.event,
      path: filePath,
    });
  } catch (writeErr: unknown) {
    // If the file already exists, that is not a real problem.
    const code = (writeErr as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      log.info("dead letter already exists, skipping duplicate write", {
        deliveryId: opts.delivery_id,
        path: filePath,
      });
      return;
    }
    log.error("failed to write dead letter", {
      deliveryId: opts.delivery_id,
      path: filePath,
      error:
        writeErr instanceof Error ? writeErr.message : String(writeErr),
    });
  }
}

// ---------------------------------------------------------------------------
// Rotation sweeper
// ---------------------------------------------------------------------------

/**
 * Delete date-directories older than DEAD_LETTER_RETENTION_DAYS (default 30).
 * Called once at process start; controlled by env var DEAD_LETTER_SWEEP=false
 * to disable entirely.
 */
export async function sweepDeadLetters(
  options: {
    baseDir?: string;
    retentionDays?: number;
    now?: Date;
  } = {},
): Promise<void> {
  if (process.env.DEAD_LETTER_SWEEP === "false") return;

  const baseDir = options.baseDir ?? getDeadLetterDir();
  const retentionDays = options.retentionDays ?? getRetentionDays();
  const now = options.now ?? new Date();
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // nothing written yet
    log.error("dead letter sweep: failed to list dir", {
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
        log.info("dead letter sweep: removed old dir", {
          dir: entry,
          retentionDays,
        });
      } catch (rmErr: unknown) {
        log.error("dead letter sweep: failed to remove dir", {
          dir: entry,
          error: rmErr instanceof Error ? rmErr.message : String(rmErr),
        });
      }
    }
  }
}
