#!/usr/bin/env bun
/**
 * In-container sqlite snapshot. Uses SQLite's VACUUM INTO — an online-safe
 * snapshot API that creates a consistent copy even while the main process
 * is writing. Safer than a plain cp of state.sqlite when the server is
 * running with WAL enabled.
 *
 * Invoked by scripts/backup.sh via `docker compose exec`. Not meant to be
 * run directly from the host; there's no guard against running against a
 * DB the host's own bun is currently writing to, because the only writer
 * in production is inside the container.
 *
 * Usage:  bun run scripts/backup-db.ts <dest-path>
 */
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";

const src = process.env.AUTO_REVIEWER_DB ?? "/app/data/state.sqlite";
const dest = process.argv[2];

if (!dest) {
  console.error("usage: bun run scripts/backup-db.ts <dest-path>");
  process.exit(2);
}

if (!existsSync(src)) {
  console.error(`source DB not found: ${src}`);
  process.exit(3);
}

// VACUUM INTO fails if the destination already exists. If a stale file is
// lying around from a previous aborted backup, clear it first.
if (existsSync(dest)) unlinkSync(dest);

// Tolerate only the weird characters we might actually see in a path; reject
// anything that could break out of the SQL string literal. bun:sqlite .run
// doesn't bind-parameter VACUUM INTO, so we sanitize and sq-escape manually.
if (!/^[A-Za-z0-9_./:\- ]+$/.test(dest)) {
  console.error(`refusing unsafe dest path: ${dest}`);
  process.exit(4);
}

const db = new Database(src);
try {
  db.run(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

console.log(`snapshot written to ${dest}`);
