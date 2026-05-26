type ClaudeMode = 'subscription' | 'api';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Env ${name} is not an integer: ${raw}`);
  return n;
}

function intEnvMin(name: string, fallback: number, min: number): number {
  const n = intEnv(name, fallback);
  if (n < min) throw new Error(`Env ${name} must be >= ${min}, got: ${n}`);
  return n;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function claudeMode(name: string, fallback: ClaudeMode): ClaudeMode {
  const v = process.env[name] ?? fallback;
  if (v !== 'subscription' && v !== 'api') {
    throw new Error(`Env ${name} must be 'subscription' or 'api', got: ${v}`);
  }
  return v;
}

export const config = {
  port: intEnv('PORT', 8787),
  publicUrl: optional('PUBLIC_URL', 'http://localhost:8787'),
  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET'),
  github: {
    clientId: optional('GITHUB_CLIENT_ID', ''),
    clientSecret: optional('GITHUB_CLIENT_SECRET', ''),
    // Shared secret for the /api/webhooks/github receiver. Empty disables
    // the endpoint (the poller still covers everything); set it to the
    // same value configured on the GitHub repo/org webhook.
    webhookSecret: optional('GITHUB_WEBHOOK_SECRET', ''),
    // GitHub App credentials. When both are set, arbiter can mint
    // short-lived, finely-scoped per-installation tokens instead of
    // storing a broad OAuth user token at rest (the migration keystone).
    // Both empty = App auth fully disabled; OAuth path is unaffected.
    // Raw env only — PEM normalization (base64 / literal-\n) lives in
    // github/app.ts so config stays I/O-free and cycle-free.
    app: {
      appId: optional('GITHUB_APP_ID', ''),
      privateKey: optional('GITHUB_APP_PRIVATE_KEY', ''),
    },
  },
  claude: {
    defaultMode: claudeMode('CLAUDE_DEFAULT_MODE', 'subscription'),
    bin: optional('CLAUDE_BIN', 'claude'),
    apiKey: optional('ANTHROPIC_API_KEY', ''),
  },
  pollIntervalSeconds: intEnv('POLL_INTERVAL_SECONDS', 60),
  workerIntervalSeconds: intEnv('WORKER_INTERVAL_SECONDS', 5),
  // How many reviews the worker processes concurrently in this process.
  // The queue claim is `FOR UPDATE SKIP LOCKED`, so >1 is safe within a
  // container; raise it to drain a deep backlog faster (each slot still
  // spends a real Claude call, so size it against your quota/cost, not
  // just CPU). Set to 1 to restore the original single-flight behavior.
  workerConcurrency: intEnvMin('WORKER_CONCURRENCY', 3, 1),
  // Terminal reviews (done/failed/skipped) older than this are pruned every
  // hour by the retention task. 0 disables pruning entirely.
  reviewRetentionDays: intEnv('REVIEW_RETENTION_DAYS', 30),
  // The /api/debug/* routes (run-review burns a real Claude call; enqueue
  // mutates the queue) are useful in dev but should not be reachable in a
  // normal deployment. Off by default; opt in with ENABLE_DEBUG_ENDPOINTS=1.
  enableDebugEndpoints: boolEnv('ENABLE_DEBUG_ENDPOINTS', false),
  // Bearer token for GET /metrics (Prometheus). Empty disables the
  // endpoint entirely (404) — off by default; set it and have your
  // scraper send `Authorization: Bearer <token>`.
  metricsToken: optional('METRICS_TOKEN', ''),
} as const;

export type Config = typeof config;
