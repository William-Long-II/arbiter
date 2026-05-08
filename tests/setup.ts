// Test environment setup. Loaded via bunfig.toml `preload` before any test file.
// Bun auto-loads .env, which can leave variables defined-but-empty (e.g. an
// unfilled GITHUB_CLIENT_ID=). We force-set test values for the OAuth/runtime
// envs so tests aren't sensitive to local .env contents. DATABASE_URL is
// nullish-default only — if a developer points it at a real test DB, we honor
// that.
process.env.DATABASE_URL ??= 'postgres://localhost/reviewme_test';
const TEST_VALUES = {
  SESSION_SECRET: 'test-secret-' + 'a'.repeat(40),
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  PUBLIC_URL: 'http://localhost:8787',
  CLAUDE_DEFAULT_MODE: 'subscription',
} as const;
for (const [k, v] of Object.entries(TEST_VALUES)) {
  if (!process.env[k]) process.env[k] = v;
}
