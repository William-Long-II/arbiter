import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "../../state/db.ts";
import { log } from "../../log.ts";

/**
 * GET /api/backup (admin-only) — download a consistent SQLite snapshot
 * of the running state DB.
 *
 * Implementation uses `VACUUM INTO` so the snapshot is internally
 * consistent even when the review loop is writing concurrently. This
 * is the same mechanism `scripts/backup.sh` uses via `docker compose
 * exec`; the endpoint exists so an operator with only web access (e.g.
 * behind a tunnel) can still get a backup without SSHing to the host.
 *
 * We write into a private tmp directory, read the bytes, delete the
 * directory, and return a Response. For typical deployments the DB is
 * a few MB at most — a full in-memory read is fine. If this ever needs
 * to support much larger DBs, rework to stream the file handle instead.
 */
export function backupRoute(args: { store: Store }): Response {
  const { store } = args;
  const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]/g, "");
  const dir = mkdtempSync(join(tmpdir(), "auto-reviewer-backup-"));
  const dest = join(dir, "state.sqlite");
  try {
    // Sanitize: VACUUM INTO can't bind-parameter the destination, so we
    // manually escape single quotes. mkdtempSync picks the parent, so
    // the path is wholly under our control — the sanitization here is
    // defense-in-depth, not a trust boundary.
    const escaped = dest.replace(/'/g, "''");
    store.db.run(`VACUUM INTO '${escaped}'`);
    const bytes = readFileSync(dest);
    log.info("backup.served", { path: store.meta.path, bytes: bytes.byteLength });
    store.recordEvent({
      level: "info",
      kind: "backup.served",
      message: `Backup snapshot served (${bytes.byteLength} bytes)`,
    });
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "content-type": "application/vnd.sqlite3",
        "content-length": String(bytes.byteLength),
        "content-disposition": `attachment; filename="auto-reviewer-${stamp}.sqlite"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    const error = (e as Error).message;
    log.error("backup.failed", { error });
    // If the DB is the reason we failed, recording an event in the DB
    // will also throw. Swallow that secondary failure — the stdout log
    // line above is the reliable record, and a 500 response is more
    // valuable than a cascading error.
    try {
      store.recordEvent({
        level: "error",
        kind: "backup.failed",
        message: `Backup snapshot failed: ${error}`,
      });
    } catch {
      // already logged via log.error; ignore cascade
    }
    return new Response(`Backup failed: ${error}`, {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } finally {
    // Always clean up even on success. A leftover tmp directory isn't
    // a catastrophe on Linux (tmpfs gets wiped at boot) but is on
    // anything long-lived.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // leave it for the OS temp cleaner
    }
  }
}
