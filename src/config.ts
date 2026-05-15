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
  },
  claude: {
    defaultMode: claudeMode('CLAUDE_DEFAULT_MODE', 'subscription'),
    bin: optional('CLAUDE_BIN', 'claude'),
    apiKey: optional('ANTHROPIC_API_KEY', ''),
  },
  pollIntervalSeconds: intEnv('POLL_INTERVAL_SECONDS', 60),
  workerIntervalSeconds: intEnv('WORKER_INTERVAL_SECONDS', 5),
  // Terminal reviews (done/failed/skipped) older than this are pruned every
  // hour by the retention task. 0 disables pruning entirely.
  reviewRetentionDays: intEnv('REVIEW_RETENTION_DAYS', 30),
  // The /api/debug/* routes (run-review burns a real Claude call; enqueue
  // mutates the queue) are useful in dev but should not be reachable in a
  // normal deployment. Off by default; opt in with ENABLE_DEBUG_ENDPOINTS=1.
  enableDebugEndpoints: boolEnv('ENABLE_DEBUG_ENDPOINTS', false),
} as const;

export type Config = typeof config;
