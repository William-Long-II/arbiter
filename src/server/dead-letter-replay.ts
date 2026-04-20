/**
 * Bounded dead-letter auto-replay.
 *
 * Reads today's and yesterday's date-dirs (to handle night-time boundaries),
 * filters by age and already-replayed marker, caps at maxCount, then drives
 * each eligible file through the same webhook handler used by the manual
 * replay script.
 *
 * WHY rename instead of delete: renaming to <name>.replayed is atomic on most
 * filesystems (a single directory-entry update) and preserves the file for
 * operator audit. Deletion would be irreversible. The .replayed suffix also
 * acts as an idempotency guard — the same file is never processed twice even
 * if the bot restarts between replays.
 *
 * WHY we skip rather than retry across reboots: auto-replay is intentionally
 * bounded to recent failures (≤ maxAgeMinutes). Older failures are operator
 * territory; the manual replay script handles them.
 *
 * Honest concerns:
 *  1. .replayed files accumulate until the rotation sweep runs (after
 *     DEAD_LETTER_RETENTION_DAYS). The sweep only removes whole date-dirs, so
 *     a dir containing only .replayed files is cleaned up naturally on schedule.
 *  2. A file renamed to .replayed during the same boot cycle that runs
 *     sweepDeadLetters() could race: sweep lists the dir before rename, counts
 *     it, then rename finishes — sweep still holds the old list and may try to
 *     delete a now-renamed file. Both operations are idempotent so the race is
 *     safe (rm with force:true, rename returns ENOENT which we treat as success).
 *  3. The replay-cache nonce check in the main webhook path records every
 *     delivery ID for a TTL window. A dead-letter file replayed here reuses the
 *     original delivery_id, which may already be in the nonce cache if the
 *     original request arrived within that TTL. Auto-replay bypasses the HTTP
 *     path (calls verifyAndReceive directly), so the nonce check does NOT fire
 *     here — but if the operator later re-replays via the HTTP path it will be
 *     rejected as a duplicate. This is acceptable: the file is already .replayed.
 */

import { createHmac } from "node:crypto";
import { readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { DeadLetterEntry } from "./dead-letter";
import { log } from "./logger";
import { incDeadLetterReplay } from "./metrics";
import type { createWebhooks } from "./webhooks";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReplayResult = "success" | "failure";

export type ReplayRecentOptions = {
  /** Base dead-letter directory (e.g. "var/dead-letter"). */
  dir: string;
  /** Maximum age of files to consider, in minutes. */
  maxAgeMinutes: number;
  /** Maximum number of files to replay in this run. */
  maxCount: number;
  /** Webhooks instance initialised with bypass secret. */
  webhooks: ReturnType<typeof createWebhooks>;
  /** Secret used to re-sign payloads (bypass constant). */
  replaySecret: string;
  /** Wall-clock reference for age comparisons (injectable for tests). */
  now?: Date;
};

export type ReplaySummary = {
  success: number;
  failure: number;
  skipped: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dateDir(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Collect candidate .json files (not .replayed) from a single date-dir.
 * Returns an empty array if the dir doesn't exist — never throws.
 */
async function listCandidates(
  dirPath: string,
): Promise<Array<{ name: string; path: string }>> {
  let names: string[];
  try {
    names = await readdir(dirPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    log.error("dead-letter replay: failed to list dir", {
      path: dirPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  return names
    .filter((n) => n.endsWith(".json") && !n.endsWith(".replayed.json"))
    .map((n) => ({ name: n, path: join(dirPath, n) }));
}

// ---------------------------------------------------------------------------
// Core: replay a single file
// ---------------------------------------------------------------------------

/**
 * Read, parse, re-sign, and dispatch one dead-letter file.
 *
 * On success the file is atomically renamed to `<path>.replayed` so it is
 * never processed again. On any failure the file is left untouched — it
 * remains a dead-letter; the operator can inspect or run the manual script.
 *
 * Returns "success" | "failure" (never throws).
 */
export async function replayOne(
  filePath: string,
  webhooks: ReturnType<typeof createWebhooks>,
  replaySecret: string,
): Promise<ReplayResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    log.error("dead-letter replay: failed to read file", {
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    incDeadLetterReplay("failure");
    return "failure";
  }

  let entry: DeadLetterEntry;
  try {
    entry = JSON.parse(raw) as DeadLetterEntry;
  } catch (err: unknown) {
    log.error("dead-letter replay: invalid JSON", {
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    incDeadLetterReplay("failure");
    return "failure";
  }

  const { delivery_id, event, payload } = entry;

  // Re-sign the stored payload with the replay secret so verifyAndReceive
  // accepts it (same approach as the manual replay script).
  const freshSignature = `sha256=${createHmac("sha256", replaySecret).update(payload).digest("hex")}`;

  try {
    await webhooks.verifyAndReceive({
      id: delivery_id,
      name: event as Parameters<typeof webhooks.verifyAndReceive>[0]["name"],
      signature: freshSignature,
      payload,
    });
  } catch (err: unknown) {
    log.error("dead-letter replay: handler threw", {
      path: filePath,
      deliveryId: delivery_id,
      event,
      error: err instanceof Error ? err.message : String(err),
    });
    incDeadLetterReplay("failure");
    return "failure";
  }

  // Handler succeeded — rename to .replayed so this file is never replayed again.
  // The rename is atomic (single directory-entry update) on POSIX filesystems
  // and on Windows NTFS when src and dst are on the same volume.
  const replayedPath = `${filePath}.replayed`;
  try {
    await rename(filePath, replayedPath);
  } catch (err: unknown) {
    // If the file is gone (race with another process) treat as success — the
    // delivery was handled.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      log.error("dead-letter replay: failed to rename to .replayed", {
        path: filePath,
        replayedPath,
        error: err instanceof Error ? err.message : String(err),
      });
      // Return success anyway: the handler ran; rename failure is cosmetic.
    }
  }

  incDeadLetterReplay("success");
  return "success";
}

// ---------------------------------------------------------------------------
// Public entry point called from boot sequence
// ---------------------------------------------------------------------------

/**
 * Replay recent dead-letter files on boot.
 *
 * When `DEAD_LETTER_AUTO_REPLAY=disabled` this is a synchronous no-op with no
 * fs reads.
 *
 * Files are sourced from today's and yesterday's date-dirs to handle
 * night-time boundaries. They are sorted by `written_at` ascending (oldest
 * first within the window) and capped at maxCount. Files older than
 * maxAgeMinutes and files already ending in `.json.replayed` are skipped.
 *
 * Never throws — all errors degrade to logged warnings and skipped/failure
 * counters.
 */
export async function replayRecentDeadLetters(
  opts: ReplayRecentOptions,
): Promise<ReplaySummary> {
  const summary: ReplaySummary = { success: 0, failure: 0, skipped: 0 };

  // Safety valve: disabled entirely.
  if (process.env.DEAD_LETTER_AUTO_REPLAY === "disabled") {
    return summary;
  }

  const now = opts.now ?? new Date();
  const cutoffMs = now.getTime() - opts.maxAgeMinutes * 60 * 1_000;

  // Gather candidates from today and yesterday (night-time boundary coverage).
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const dirs = [
    join(opts.dir, dateDir(yesterday)),
    join(opts.dir, dateDir(now)),
  ];

  const allCandidates: Array<{ name: string; path: string; writtenAt: number }> = [];

  for (const dirPath of dirs) {
    const files = await listCandidates(dirPath);
    for (const { name, path } of files) {
      // Read just enough to get written_at — parse full entry later in replayOne.
      let writtenAt = 0;
      try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw) as Partial<DeadLetterEntry>;
        writtenAt = parsed.written_at ? new Date(parsed.written_at).getTime() : 0;
      } catch {
        // Unreadable / malformed: writtenAt=0 means it will be skipped as too old.
        writtenAt = 0;
      }
      allCandidates.push({ name, path, writtenAt });
    }
  }

  // Deduplicate by path (today == yesterday edge case on the same calendar date).
  const seen = new Set<string>();
  const unique = allCandidates.filter(({ path }) => {
    if (seen.has(path)) return false;
    seen.add(path);
    return true;
  });

  // Sort oldest first so the most urgent failures are replayed first within cap.
  unique.sort((a, b) => a.writtenAt - b.writtenAt);

  // Apply age filter.
  const ageEligible = unique.filter(({ writtenAt }) => writtenAt >= cutoffMs);
  const tooOld = unique.length - ageEligible.length;
  summary.skipped += tooOld;

  // Apply count cap.
  const toReplay = ageEligible.slice(0, opts.maxCount);
  const overCap = ageEligible.length - toReplay.length;
  summary.skipped += overCap;

  log.info("dead_letter.auto_replay_begin", {
    evt: "dead_letter.auto_replay_begin",
    candidate_count: toReplay.length,
    skipped_too_old: tooOld,
    skipped_over_cap: overCap,
  });

  for (const { path } of toReplay) {
    const result = await replayOne(path, opts.webhooks, opts.replaySecret);
    summary[result] += 1;
  }

  log.info("dead_letter.auto_replay_done", {
    evt: "dead_letter.auto_replay_done",
    success: summary.success,
    failure: summary.failure,
    skipped: summary.skipped,
  });

  return summary;
}
