// Test environment setup. Loaded via bunfig.toml `preload` before any test file.
// Bun auto-loads .env, which may contain real OAuth credentials and other
// runtime values. Tests must run against KNOWN values, so we always overwrite
// these regardless of what's in .env.
//
// DATABASE_URL is the exception: it stays nullish-default so a developer can
// point tests at a real test DB by setting DATABASE_URL in their shell.
process.env.DATABASE_URL ??= 'postgres://localhost/reviewme_test';
const FORCED_TEST_VALUES = {
  SESSION_SECRET: 'test-secret-' + 'a'.repeat(40),
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  PUBLIC_URL: 'http://localhost:8787',
  CLAUDE_DEFAULT_MODE: 'subscription',
} as const;
for (const [k, v] of Object.entries(FORCED_TEST_VALUES)) {
  process.env[k] = v;
}
