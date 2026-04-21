/**
 * Best-effort queue persistence for in-flight review tasks (issue #92).
 *
 * Tasks in the review queue are closures and cannot be serialised directly.
 * Instead, we serialise only the *intent*: the minimum information needed to
 * reconstruct a `runPipeline` call on the next boot.
 *
 * Layout on disk:
 *   ${QUEUE_STATE_DIR}/pending.json                  — live snapshot
 *   ${QUEUE_STATE_DIR}/pending.json.tmp              — write-then-rename target
 *   ${QUEUE_STATE_DIR}/pending.json.restored.${ts}  — consumed snapshot (audit)
 *   ${QUEUE_STATE_DIR}/pending.json.corrupt.${ts}   — unreadable snapshot (audit)
 *
 * Default dir: ./var/queue
 *
 * Env vars:
 *   QUEUE_STATE_DIR                 — base directory (default ./var/queue)
 *   QUEUE_STALE_MAX_MINUTES         — entries older than this are discarded at
 *                                     restore time (default 60)
 *   QUEUE_SNAPSHOT_INTERVAL_SECONDS — periodic snapshot cadence in seconds;
 *                                     0 disables (default 30)
 *
 * Honest concern: if the PipelineDeps / ResolvedRepoConfig shape changes
 * between deploys, old snapshots contain stale `entry` values.  They are
 * re-enqueued with whatever shape was serialised — if the new code is
 * backward-compatible this is fine; if not, the pipeline will fail gracefully
 * and the task will be logged as a pipeline error (same path as any other
 * runPipeline failure).  The safest mitigation is a short QUEUE_STALE_MAX_MINUTES.
 *
 * Atomic rename on Windows:
 *   Node's fs.rename is not atomic when src and dst are on different volumes,
 *   but for same-volume tmp→pending renames within var/queue it is a single
 *   MoveFile operation on NTFS which is atomic at the directory-entry level.
 *   A crash mid-rename may leave pending.json.tmp behind; we ignore stale .tmp
 *   files at boot (only pending.json is consumed).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger";
import { incQueuePersistence } from "./metrics";
import { enqueueOrThrow, getPendingRecords, type QueueRecord } from "./queue";
import type { PipelineDeps, PrRef } from "./webhooks";

// ---------------------------------------------------------------------------
// Env-var helpers (exported for tests)
// ---------------------------------------------------------------------------

export function getQueueStateDir(): string {
  return process.env.QUEUE_STATE_DIR ?? "./var/queue";
}

export function getQueueStaleMaxMinutes(): number {
  const raw = process.env.QUEUE_STALE_MAX_MINUTES;
  if (raw !== undefined) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 60;
}

export function getQueueSnapshotIntervalSeconds(): number {
  const raw = process.env.QUEUE_SNAPSHOT_INTERVAL_SECONDS;
  if (raw !== undefined) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 30;
}

// ---------------------------------------------------------------------------
// Snapshot shape on disk
// ---------------------------------------------------------------------------

type SnapshotFile = {
  written_at: string;
  records: QueueRecord[];
};

// ---------------------------------------------------------------------------
// RunPipeline type (matches the exported function from webhooks.ts)
// ---------------------------------------------------------------------------

/** Type of the runPipeline function injected at boot. */
export type RunPipelineFn = (ref: PrRef, deps: PipelineDeps) => Promise<void>;

// ---------------------------------------------------------------------------
// snapshotQueue
// ---------------------------------------------------------------------------

/**
 * Write all pending (not yet started) queue records to disk.
 *
 * Uses a write-then-rename pattern so the live `pending.json` is always a
 * complete file from the reader's perspective.
 *
 * Never throws — snapshot failures are logged and metered but must not block
 * the review flow or the SIGTERM drain.
 */
export async function snapshotQueue(dir: string = getQueueStateDir()): Promise<void> {
  const records = getPendingRecords();

  // Even if records is empty we still write (to clear any stale pending.json).
  const snapshot: SnapshotFile = {
    written_at: new Date().toISOString(),
    records,
  };

  const tmpPath = join(dir, "pending.json.tmp");
  const finalPath = join(dir, "pending.json");

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(snapshot, null, 2) + "\n", {
      encoding: "utf8",
    });
    await rename(tmpPath, finalPath);
    log.info("queue.snapshot_written", {
      evt: "queue.snapshot_written",
      pendingCount: records.length,
      path: finalPath,
    });
    incQueuePersistence("snapshot_ok");
  } catch (err: unknown) {
    log.error("queue.snapshot_failed", {
      evt: "queue.snapshot_failed",
      error: err instanceof Error ? err.message : String(err),
      path: finalPath,
    });
    incQueuePersistence("snapshot_failed");
  }
}

// ---------------------------------------------------------------------------
// restoreQueue
// ---------------------------------------------------------------------------

/**
 * At-boot restore: read `pending.json`, filter stale entries, re-enqueue
 * each via `enqueueOrThrow(() => runPipelineFn(...))`, then rename the file
 * to an audit copy.
 *
 * Never throws — restore failures are logged and metered.
 *
 * @param dir            Directory containing `pending.json`.
 * @param liveDeps       Live pipeline dependencies from the server context
 *                       (octokit, anthropic, selfLogin, jiraCreds).  These
 *                       always use current credentials regardless of what was
 *                       serialised.
 * @param runPipelineFn  Injected `runPipeline` from webhooks.ts.
 * @param now            Wall-clock reference for stale-entry comparison
 *                       (injectable for tests).
 */
export async function restoreQueue(
  dir: string,
  liveDeps: Pick<PipelineDeps, "octokit" | "anthropic" | "selfLogin" | "jiraCreds">,
  runPipelineFn: RunPipelineFn,
  now: Date = new Date(),
): Promise<void> {
  const pendingPath = join(dir, "pending.json");
  const ts = now.getTime();

  // ---------------------------------------------------------------------------
  // Step 1: read pending.json
  // ---------------------------------------------------------------------------
  let raw: string;
  try {
    raw = await readFile(pendingPath, "utf8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Fresh install — nothing to restore.
      log.debug("queue.restore_no_file", {
        evt: "queue.restore_no_file",
        path: pendingPath,
      });
      return;
    }
    log.error("queue.restore_read_failed", {
      evt: "queue.restore_read_failed",
      path: pendingPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 2: parse — on corrupt JSON rename to .corrupt.${ts}
  // ---------------------------------------------------------------------------
  let snapshot: SnapshotFile;
  try {
    snapshot = JSON.parse(raw) as SnapshotFile;
    if (!Array.isArray(snapshot.records)) {
      throw new Error("records field is not an array");
    }
  } catch (parseErr: unknown) {
    const corruptPath = join(dir, `pending.json.corrupt.${ts}`);
    log.error("queue.restore_corrupt", {
      evt: "queue.restore_corrupt",
      path: pendingPath,
      corruptPath,
      error: parseErr instanceof Error ? parseErr.message : String(parseErr),
    });
    try {
      await rename(pendingPath, corruptPath);
    } catch (renameErr: unknown) {
      log.error("queue.restore_corrupt_rename_failed", {
        evt: "queue.restore_corrupt_rename_failed",
        path: pendingPath,
        corruptPath,
        error: renameErr instanceof Error ? renameErr.message : String(renameErr),
      });
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Step 3: filter stale entries
  // ---------------------------------------------------------------------------
  const staleMaxMs = getQueueStaleMaxMinutes() * 60 * 1_000;
  const fresh: QueueRecord[] = [];
  let staleCount = 0;

  for (const record of snapshot.records) {
    const queuedAtMs = new Date(record.queuedAt).getTime();
    if (Number.isNaN(queuedAtMs) || now.getTime() - queuedAtMs > staleMaxMs) {
      log.info("queue.restore_skipped_stale", {
        evt: "queue.restore_skipped_stale",
        taskId: record.taskId,
        deliveryId: record.deliveryId,
        queuedAt: record.queuedAt,
      });
      incQueuePersistence("skipped_stale");
      staleCount++;
    } else {
      fresh.push(record);
    }
  }

  log.info("queue.restore_begin", {
    evt: "queue.restore_begin",
    total: snapshot.records.length,
    fresh: fresh.length,
    stale: staleCount,
  });

  // ---------------------------------------------------------------------------
  // Step 4: re-enqueue fresh entries via enqueueOrThrow (best-effort)
  // ---------------------------------------------------------------------------
  for (const record of fresh) {
    const pipelineDeps: PipelineDeps = {
      octokit: liveDeps.octokit,
      anthropic: liveDeps.anthropic,
      selfLogin: liveDeps.selfLogin,
      jiraCreds: liveDeps.jiraCreds,
      deliveryId: record.deliveryId,
      source: record.source as PipelineDeps["source"],
      // The entry is serialised as plain JSON so the shape may differ from the
      // current ResolvedRepoConfig; the cast is intentional (best-effort).
      entry: record.entry as PipelineDeps["entry"],
    };

    const ref: PrRef = record.ref;

    try {
      enqueueOrThrow(
        () => runPipelineFn(ref, pipelineDeps),
        { deliveryId: record.deliveryId, restored: true },
        // No pendingRecord: restored tasks are not snapshotted again.
      );
      log.info("queue.restore_enqueued", {
        evt: "queue.restore_enqueued",
        taskId: record.taskId,
        deliveryId: record.deliveryId,
      });
      incQueuePersistence("restore_ok");
    } catch (enqErr: unknown) {
      log.error("queue.restore_enqueue_failed", {
        evt: "queue.restore_enqueue_failed",
        taskId: record.taskId,
        deliveryId: record.deliveryId,
        error: enqErr instanceof Error ? enqErr.message : String(enqErr),
      });
      incQueuePersistence("restore_failed");
    }
  }

  // ---------------------------------------------------------------------------
  // Step 5: rename pending.json to .restored.${ts} (audit copy)
  // ---------------------------------------------------------------------------
  const restoredPath = join(dir, `pending.json.restored.${ts}`);
  try {
    await rename(pendingPath, restoredPath);
    log.info("queue.restore_done", {
      evt: "queue.restore_done",
      restored: fresh.length,
      stale: staleCount,
      auditPath: restoredPath,
    });
  } catch (renameErr: unknown) {
    log.warn("queue.restore_rename_failed", {
      evt: "queue.restore_rename_failed",
      path: pendingPath,
      restoredPath,
      error: renameErr instanceof Error ? renameErr.message : String(renameErr),
    });
  }
}
