// Test environment setup. Loaded via bunfig.toml `preload` before any test file.
// Provides defaults so importing src/config.ts during tests doesn't throw.
process.env.DATABASE_URL ??= 'postgres://localhost/reviewme_test';
process.env.SESSION_SECRET ??= 'test-secret-' + 'a'.repeat(40);
process.env.GITHUB_CLIENT_ID ??= 'test-client-id';
process.env.GITHUB_CLIENT_SECRET ??= 'test-client-secret';
process.env.PUBLIC_URL ??= 'http://localhost:8787';
