import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { config } from './config.ts';
import { publish, type ReviewEvent } from './events.ts';

export const sql = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
});

/**
 * Start listening on the Postgres `reviews_changed` NOTIFY channel and
 * fan out each payload to the in-process events bus. Called once at
 * startup. Uses a dedicated long-lived connection under the hood
 * (postgres.js handles that internally).
 *
 * Payload contract: JSON-encoded ReviewEvent. Anyone calling NOTIFY
 * must produce the same shape — the helper in db/reviews.ts is the
 * single source of truth for that.
 */
export async function startEventListener(): Promise<void> {
  await sql.listen('reviews_changed', (raw) => {
    let event: ReviewEvent;
    try {
      event = JSON.parse(raw) as ReviewEvent;
    } catch (err) {
      console.error('[events] bad NOTIFY payload:', raw, err);
      return;
    }
    publish(event);
  });
  console.log('[events] LISTEN reviews_changed');
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

export async function runMigrations(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    (await sql<{ filename: string }[]>`SELECT filename FROM schema_migrations`).map(
      (r) => r.filename,
    ),
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(join(migrationsDir, file), 'utf8');
    console.log(`[migrate] applying ${file}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file})`;
    });
  }
}
