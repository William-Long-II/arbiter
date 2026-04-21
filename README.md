# review-me

An intent-aware GitHub pull-request review bot. Listens for webhooks, waits until CI goes green, then posts a constructive review — approving clean PRs and leaving line-level guidance on ones with issues. Never blocks a merge. Built with Bun + TypeScript; deployable on your own VMs behind an existing HTTPS reverse proxy.

## What it does

1. GitHub sends `pull_request.*`, `check_suite.completed`, `issue_comment.created`, and `pull_request_review_comment.created` webhooks to `/webhook`.
2. For allowlisted repos, the bot waits until the check suite's aggregate status is green.
3. It fetches the PR diff (rename-aware; lockfiles, binaries, and `linguist-generated` files stripped), resolves the intent from a pluggable provider chain (Jira → GitHub Issues → Linear, falling back to PR description), ingests the target repo's own conventions (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.cursorrules`), computes a deterministic test-coverage delta (added source lines vs. added test lines, plus flagged untested symbols), attaches per-language heuristic hints (TypeScript, Python, Go, Java), and runs a Claude Opus 4.7 review. Results are cached per `(repo, head SHA)` for 10 minutes so redundant webhook re-triggers don't burn tokens.
4. For large PRs the reviewer runs a two-pass summarize-then-synthesize pipeline so the bot still produces actionable feedback where it would previously have failed open.
5. The review is posted as a GitHub review — `APPROVE` for clean PRs, `COMMENT` with inline feedback when there's something to call out. It never uses `REQUEST_CHANGES`.
6. If a human replies to a bot line-comment, the bot replies once in-thread (capped at three replies per thread; `/stop` in a reply ends the thread permanently).
7. Per-repo config (with org-level defaults) decides whether re-reviews trigger automatically on every push (`auto-on-sync`) or only when a reviewer applies a label or mentions `/review-me` in a comment (`label-or-mention`).
8. Draft PRs are skipped entirely — the bot does not review them until the author marks the PR as ready for review, at which point the normal CI-gate flow runs. PRs titled `WIP:`, `Draft:`, `[skip-review]`, `[WIP]`, or opened on branches prefixed `wip/` / `draft/` are also skipped implicitly; normal reviews resume once the title or branch changes.
9. Operators and reviewers control the bot via slash commands in any PR comment: `/review-me` re-triggers a review, `/review-me refresh` bypasses the result cache for a fresh review, `/review-me skip` pauses it for that PR (7-day TTL), `/review-me resume` re-enables it, `/review-me help` lists the commands.
10. Each repo can set a weekly token budget (`review.max_weekly_tokens` in `repos.yaml`). When the budget is hit the bot returns a short summary-only comment instead of calling the LLM, and automatically resumes full reviews the following ISO week.

---

## Install and run — step by step

This walkthrough goes from a clean checkout to a bot that posts a real review on a throwaway test repo.

### 1. Prerequisites

- **Bun 1.3+** — install with `curl -fsSL https://bun.sh/install | bash` (Linux/macOS) or `powershell -c "irm bun.sh/install.ps1 | iex"` (Windows).
- A GitHub account that will act as the **machine user** (the bot posts reviews as this user, and those reviews count toward branch protection). Use a dedicated account — do not use your personal one.
- An **Anthropic API key** — create at `https://console.anthropic.com/settings/keys`.
- Optional: **Jira Cloud** API token + email, **Linear** API key for intent lookups. If none are configured the bot uses `Fixes #N` references in the PR title/body, then the PR description as a final fallback.

### 2. Create the machine user's GitHub token

On the machine user account (not your personal one):

1. Go to `Settings → Developer settings → Personal access tokens → Fine-grained tokens`.
2. Generate a new token scoped to the repositories the bot should review.
3. Grant these repository permissions:
   - **Pull requests**: Read and write
   - **Contents**: Read-only
   - **Checks**: Read-only
   - **Issues**: Read-only (for GitHub-Issue intent provider and `/review-me` comment handling)
   - **Metadata**: Read-only (automatic)
4. Copy the token. This is `GITHUB_PAT` below.

Add the machine user as a collaborator (or team member with write access) on each repo you want reviewed.

### 3. Clone and install dependencies

```bash
git clone git@github.com:William-Long-II/review-me.git
cd review-me
bun install --frozen-lockfile
```

### 4. Configure environment

```bash
cp .env.example .env
```

Open `.env` and set:

| Required | Value |
|---|---|
| `GITHUB_PAT` | the fine-grained PAT from step 2 |
| `GITHUB_WEBHOOK_SECRET` | a random string — generate with `openssl rand -hex 32`. Also paste this into GitHub's webhook settings in step 6. |
| `ANTHROPIC_API_KEY` | key from `https://console.anthropic.com/settings/keys` |

Optional intent-source credentials:

- `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` — enables Jira intent provider (all three required together).
- `LINEAR_API_KEY` — enables Linear intent provider.
- `INTENT_PROVIDERS=jira,github-issue,linear` — priority order. Default covers all three; providers whose credentials aren't set are skipped silently.

See [Configuration reference](#configuration-reference) for every variable.

### 5. Allowlist repositories

Edit `repos.yaml`:

```yaml
# Org-level defaults — applied to every repo under that org unless overridden below.
orgs:
  acme:
    enabled: true
    rereview: auto-on-sync

# Per-repo entries override org defaults for that specific repo.
repos:
  acme/widget:
    enabled: true
    rereview: auto-on-sync
  acme/legacy-service:
    enabled: true
    rereview: label-or-mention
    rereview_label: re-review
```

Both `orgs:` and `repos:` are optional. A repo is allowed if it has an explicit enabled entry, or if its owner has an enabled `orgs:` entry. Per-field resolution order: explicit repo → org default → built-in default.

No restart needed for future edits — `SIGHUP` hot-reloads the file (see [Operations](#operations)).

### 6. Register the webhook

In each allowlisted repo (or, better, at the org level if available):

1. Go to the repo's `Settings → Webhooks → Add webhook`.
2. **Payload URL**: for local testing, use a tunnel (step 7). For production, your reverse-proxy URL — e.g., `https://your-host/review-me/webhook`.
3. **Content type**: `application/json`
4. **Secret**: the same random string you put in `GITHUB_WEBHOOK_SECRET`.
5. **SSL verification**: enabled.
6. **Events** → *Let me select individual events*:
   - Pull requests
   - Check suites
   - Issue comments
   - Pull request review comments
7. **Active**: checked.

### 7. Run the bot

```bash
bun run dev       # watch mode (reloads on file changes)
# or
bun run start     # one-shot
```

You should see a structured log line on startup:

```
{"ts":"...","level":"info","msg":"server started","hostname":"127.0.0.1","port":3000,"allowlistedRepos":2,"jiraConfigured":true}
```

For local testing without exposing anything, skip to the [Local testing](#local-testing) section. For production, continue to [Deployment](#deployment).

### 8. Verify end-to-end (optional)

Open a pull request on a repo in your allowlist. Once CI goes green, within ~60 seconds you should see a review posted by the machine user. If not, check:

- Server logs for error entries (`level:"error"` or `evt:"review.error"`).
- The GitHub webhook's **Recent Deliveries** tab — responses should be `200`.
- That your machine user has write access on the target repo.

---

## Configuration reference

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` | HTTP listen port |
| `HOSTNAME` | no | `127.0.0.1` | Bind address |
| `GITHUB_PAT` | **yes** | — | Machine-user fine-grained PAT |
| `GITHUB_WEBHOOK_SECRET` | **yes** | — | Primary shared secret for HMAC signature verification |
| `GITHUB_WEBHOOK_SECRET_SECONDARY` | no | — | Secondary webhook secret accepted during rotation; remove once rotation is complete |
| `GITHUB_MACHINE_USER_LOGIN` | no | — | Skip the `GET /user` lookup at boot. Use for local dev with placeholder PATs; leave unset in prod. |
| `ANTHROPIC_API_KEY` | **yes** | — | For the Claude review pass |
| `REPOS_PATH` | no | `./repos.yaml` | Path to the allowlist file |
| `REVIEW_MODE` | no | `auto` | `auto` picks chunked for large diffs; `single` forces single-pass (fails open on oversize); `chunked` forces two-pass for every PR |
| `REVIEW_QUEUE_MAX` | no | `32` | In-flight review queue capacity; excess returns 503 |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | no | — | Enable Jira intent provider (all three required together) |
| `LINEAR_API_KEY` | no | — | Enable Linear intent provider |
| `INTENT_PROVIDERS` | no | `jira,github-issue,linear` | Comma-separated provider priority; missing-credential providers are skipped |
| `RATELIMIT_RPM` | no | `60` | Steady-state webhook RPM per installation |
| `RATELIMIT_BURST` | no | `120` | Burst bucket size per installation |
| `SHUTDOWN_DRAIN_SECONDS` | no | `60` | Max seconds to wait for in-flight reviews on `SIGTERM` |
| `USAGE_LOG_DIR` | no | `./var/usage` | Directory for JSONL per-review token-usage records |
| `DEAD_LETTER_DIR` | no | `./var/dead-letter` | Directory for events that exhaust the handler |
| `DEAD_LETTER_RETENTION_DAYS` | no | `30` | Retention for dead-letter date-dirs |
| `DEAD_LETTER_AUTO_REPLAY` | no | `enabled` | `enabled` or `disabled` — replays recent dead-letter records on boot |
| `DEAD_LETTER_REPLAY_MAX_AGE_MINUTES` | no | `60` | Max age of DL files eligible for auto-replay |
| `DEAD_LETTER_REPLAY_MAX_COUNT` | no | `50` | Hard cap on DL files replayed per boot |
| `LARGE_PR_FILES_THRESHOLD` | no | `50` | Kept-file count above which a `review.large_pr` log + metric fires |
| `LARGE_PR_LOC_THRESHOLD` | no | `3000` | Added-plus-deleted LoC (over kept files) above which the same signal fires |
| `LLM_BACKEND` | no | `api` | `api` uses `ANTHROPIC_API_KEY`; `claude-cli` uses the `claude` CLI (Max subscription) — see [backend section](#alternate-backend-claude-cli-max-subscription) |
| `AUDIT_MAX_PROMPT_BYTES` | no | — | When set, caps stored prompt/response size in audit records (bytes, UTF-8-safe) |
| `QUEUE_STATE_DIR` | no | `./var/queue` | Directory for in-flight queue snapshots used to survive restarts |
| `QUEUE_STALE_MAX_MINUTES` | no | `60` | Discard queue entries older than this at restore time |
| `QUEUE_SNAPSHOT_INTERVAL_SECONDS` | no | `30` | Periodic snapshot interval; `0` disables periodic snapshotting (SIGTERM still snapshots) |
| `AUDIT_LOG_DIR` | no | `./var/audit` | Directory for prompt + LLM-response audit records; set to `disabled` to suppress writes |
| `AUDIT_RETENTION_DAYS` | no | `7` | Retention for audit date-dirs |
| `METRICS_BIND_TOKEN` | no | — | If set, `GET /metrics` requires `Authorization: Bearer <token>` |

### `repos.yaml` schema

```yaml
orgs:
  <org-name>:
    enabled: boolean          # default true
    rereview: auto-on-sync | label-or-mention
    rereview_label: string    # only meaningful for label-or-mention
    review:
      include_paths: [glob, ...]         # only review files matching; others omitted
      exclude_paths: [glob, ...]         # omit files matching these globs
      max_weekly_tokens: integer         # optional; summary-only once exhausted, resets on ISO week roll
      anthropic_api_key_env: string      # optional; name of env var holding this org's Anthropic key

repos:
  <owner/name>:
    enabled: boolean          # default true
    rereview: auto-on-sync | label-or-mention
    rereview_label: string
    review: { include_paths, exclude_paths, max_weekly_tokens, anthropic_api_key_env }
```

Repo entries override org defaults field-by-field. A repo is allowed if it has an explicit enabled entry OR its owner has an enabled `orgs:` entry.

---

## Local testing

### Signed fixtures only — no outbound calls

Leave `repos.yaml` empty and run the server; signature-valid webhooks for non-allowlisted repos are acknowledged but never reach GitHub or Anthropic.

```bash
# Terminal 1
bun run dev

# Terminal 2
GITHUB_WEBHOOK_SECRET=$(grep GITHUB_WEBHOOK_SECRET .env | cut -d= -f2) \
  bun scripts/send-webhook.ts ping fixtures/ping.json

GITHUB_WEBHOOK_SECRET=$(...) \
  bun scripts/send-webhook.ts check_suite fixtures/check_suite.completed.json
```

On Windows, Bun's default bind address can be finicky with `127.0.0.1` — set `HOSTNAME=0.0.0.0` in `.env` for local dev.

### Full pipeline against a throwaway repo

1. Create a private test repo; add the machine user as a collaborator.
2. Add it to `repos.yaml`.
3. Expose your local server with a tunnel: `cloudflared tunnel --url http://localhost:3000` (or ngrok, etc.).
4. Register the tunnel URL as the webhook target (see [step 6](#6-register-the-webhook)).
5. Open a PR — you'll get a real review once CI goes green.

### End-to-end smoke harness

A deterministic in-process mock of GitHub + Anthropic is wired up for regression testing:

```bash
bun run smoke     # full pipeline against mocks, asserts on the golden prompt
bun test          # also runs the smoke harness headless
```

---

## Deployment

Self-hosted on your own infrastructure. HTTPS is terminated at your existing reverse proxy (nginx / caddy / traefik); the bot binds plain HTTP internally.

### Docker

```bash
docker compose up -d --build
```

`docker-compose.yml` binds the container to `127.0.0.1:3000` so only the reverse proxy on the same host can reach it. `repos.yaml` is mounted read-only so the allowlist can be updated without rebuilding the image. To hot-reload the allowlist: `docker kill --signal=SIGHUP <container>`.

### systemd (bare metal)

```bash
# One-time setup on the host:
sudo useradd --system --home /opt/review-me --shell /usr/sbin/nologin review-me
sudo mkdir -p /opt/review-me /etc/review-me
sudo cp -r . /opt/review-me
sudo chown -R review-me:review-me /opt/review-me
sudo cp .env.example /etc/review-me/review-me.env    # then edit with real values
sudo chmod 600 /etc/review-me/review-me.env
sudo chown review-me:review-me /etc/review-me/review-me.env

# Install Bun system-wide:
curl -fsSL https://bun.sh/install | sudo bash -s -- --install-dir=/usr/local
sudo -u review-me bash -c "cd /opt/review-me && /usr/local/bin/bun install --frozen-lockfile --production"

# Enable the service:
sudo cp deploy/review-me.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now review-me
sudo journalctl -u review-me -f
```

### Reverse proxy

Route `POST /webhook` (and optionally `/health`, `/ready`, `/metrics`) from your public ingress to the bot. nginx example:

```nginx
location /review-me/webhook {
    proxy_pass http://127.0.0.1:3000/webhook;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    client_max_body_size 10m;
}
```

Only expose `/webhook` publicly; keep `/metrics` on the private network (or gate it with `METRICS_BIND_TOKEN`).

---

## Operations

### Endpoints

- `GET /health`, `GET /ready` — `200 ok` normally; `503 draining` during `SIGTERM` drain.
- `GET /metrics` — Prometheus text format; gated by `METRICS_BIND_TOKEN` if set.

### Hot-reload the allowlist

Edit `repos.yaml`, then signal the process — **no restart required**:

- systemd: `sudo systemctl kill --kill-who=main --signal=SIGHUP review-me`
- Docker: `docker kill --signal=SIGHUP <container>`
- bare process: `kill -HUP <pid>`

On parse/IO error the old snapshot is preserved and the error is logged. In-flight events continue with their pre-reload snapshot; only new events pick up the refresh. **Windows caveat**: SIGHUP is not a real signal on Windows — the handler is registered but never fires; restart the process there.

### Graceful shutdown

On `SIGTERM`, the bot:

1. Sets `/health` and `/ready` to `503 draining` so reverse proxies depool.
2. Returns `429 shutting down` for new webhooks.
3. Waits up to `SHUTDOWN_DRAIN_SECONDS` (default 60) for the in-flight review queue to drain.
4. Exits cleanly.

`SIGINT` (Ctrl-C) stays as fast-kill for local dev.

### Rate limiting

Webhook ingress is token-bucketed per `X-GitHub-Hook-Installation-Target-ID` at `RATELIMIT_RPM`/`RATELIMIT_BURST`. Over-limit deliveries return `429` with a numeric `Retry-After` header. Check happens before signature verification so cheap rejects don't burn CPU.

### HMAC replay protection

Delivery IDs are cached for 10 minutes after a successful signature verify. A second webhook with the same ID returns `409` even if the signature is valid. Unknown `X-GitHub-Event` values are rejected with `400` before signature verification.

### Circuit breaker

Calls to Anthropic are gated by a three-state circuit breaker. When the failure ratio exceeds 50% over a rolling 60-second window with at least 20 samples, the breaker **opens** for 60 seconds and new review requests short-circuit with a `CircuitOpenError` rather than queuing more retries. After the open window elapses, a single probe request is admitted (**half-open**); success closes the breaker, failure reopens it for another 60 seconds. Current state is observable via `reviewme_breaker_state{dep}` (see [Metrics](#metrics)).

### Slash commands

Any user can drive the bot from a PR comment. Commands must appear at the start of a line (case-insensitive):

- `/review-me` — re-trigger a review (the original command, still the default).
- `/review-me help` — post a short command reference as a comment.
- `/review-me skip` — suppress the bot on this PR for 7 days (per-PR, in-memory, TTL-bounded).
- `/review-me refresh` — evict the result cache for this PR's head SHA and re-run a fresh review.
- `/review-me resume` — clear an active skip.

The bot only reacts to slash commands it did not author; `reviewme_slash_command_total{command}` tracks usage.

### Weekly token budget

Repos can set `review.max_weekly_tokens` in `repos.yaml` (per-repo or inherited from the `orgs:` layer). When the rolling ISO-week token total (summed from the usage JSONL) reaches the cap, further reviews on that repo return a short summary-only comment — no LLM call — until Monday 00:00 UTC rolls the window. The metric `reviewme_budget_exhausted_total{repo}` fires every time the cap blocks a review.

### Per-repo Anthropic key override

Repos can pin reviews to a specific Anthropic API key for per-team cost attribution. Set `review.anthropic_api_key_env: NAME_OF_ENV_VAR` in `repos.yaml`; the bot will resolve the value from `process.env[NAME_OF_ENV_VAR]` at review time and use a fresh client for that request. **The config file never holds the key itself — only the env-var name.** When the configured env var is empty the bot falls back to the shared default key and logs a warning.

### Prompt-cache observability

The system prompt is cached via Anthropic's `cache_control`. Every review emits a `prompt.cache` log line with `hit_ratio`, `cache_read_tokens`, `cache_creation_tokens`, and `input_tokens`. The per-kind totals also land in `reviewme_prompt_cache_read_tokens_total` and `reviewme_prompt_cache_creation_tokens_total` for long-term trending. On a repo with steady flow, hit-ratio above `0.5` is a sign the cache is paying for itself; below `0.2` usually means the prompt prefix is churning.

### Review-comment thread resolution

When a reviewer marks a bot line-comment thread as Resolved in GitHub's UI, the bot stops replying to new messages in that thread (queried via GraphQL before every reply, cached 5 minutes). Resolving is the UI-equivalent of a user typing `/stop` — both halt the conversation cleanly. Tracked by `reviewme_thread_resolved_skip_total`.

### Auto-resolve stale bot threads on new reviews

When a new review lands on a PR, the bot automatically Resolves any still-open bot threads whose `originalCommit` doesn't match the current head SHA. Keeps the PR UI's "unresolved" count honest and prevents stale feedback from pretending to still be live. Capped at 50 resolutions per review to stay within GitHub API quotas. Metric: `reviewme_thread_auto_resolved_total`.

### Large-PR warning signal

When a post-filter PR exceeds `LARGE_PR_FILES_THRESHOLD` (default 50 files) or `LARGE_PR_LOC_THRESHOLD` (default 3000 LoC), the bot emits a `review.large_pr` log and bumps `reviewme_large_pr_total{reason}` (`files`/`loc`/`both`). Observation-only — the normal pipeline (chunker, budget, cache) is unaffected. Use the metric to alert on outliers before they show up as token spikes in the weekly usage report.

### Dead-letter auto-replay on boot

On startup, after the retention sweep, the bot automatically replays any dead-letter files newer than `DEAD_LETTER_REPLAY_MAX_AGE_MINUTES` (default 60), up to `DEAD_LETTER_REPLAY_MAX_COUNT` (default 50). Successfully-replayed files are renamed to `<name>.replayed` so they are not re-attempted on the next boot. Set `DEAD_LETTER_AUTO_REPLAY=disabled` to opt out. Metric: `reviewme_dead_letter_replay_total{result}`.

### Alternate backend: Claude CLI (Max subscription)

The default LLM backend uses `ANTHROPIC_API_KEY` via the Anthropic SDK. Operators running the bot on their own machine can instead point it at the `claude` CLI — which uses whatever auth `claude /login` set up, including a Claude Max subscription.

```bash
# One-time, on the host running the bot:
claude /login

# Then in .env:
LLM_BACKEND=claude-cli
# ANTHROPIC_API_KEY is not read in this mode — leave set or unset.
```

At boot the bot runs `claude --version` once. If the binary is missing or unresponsive within 5 seconds, the process exits with code 1 — a misconfigured backend at startup beats failing every review at runtime. When the CLI returns output that can't be parsed into the review schema, the bot falls back to a summary-only verdict (`verdict: "comment"`) and emits a `backend.schema_fallback` warn log rather than throwing.

**Tradeoffs to know:**
- Max subscription usage is metered differently than the API (5-hour windows, message caps) — check Anthropic's terms before using it for automated workloads.
- The `claude-cli` backend does not honor the per-repo `review.anthropic_api_key_env` override (Max subscriptions don't accept alternate keys).
- Prompt caching behavior differs from the SDK path; the cache-hit metric may be zero for CLI-backend deployments.
- The thread-reply handler for `/review-me` follow-ups stays on the API backend.

### Queue persistence across restarts

In-flight review tasks are snapshotted to `${QUEUE_STATE_DIR}/pending.json` every `QUEUE_SNAPSHOT_INTERVAL_SECONDS` (default 30) AND on `SIGTERM` before drain. At boot the bot reads this file, re-enqueues tasks, and renames it to `pending.json.restored.<ts>` for audit. Entries older than `QUEUE_STALE_MAX_MINUTES` (default 60) are discarded and logged. Set `QUEUE_SNAPSHOT_INTERVAL_SECONDS=0` to disable periodic snapshotting (SIGTERM snapshotting still runs). Useful especially for laptop / local-run deployments where restarts are frequent.

### Review traceability footer

Every posted review summary ends with a hidden HTML comment recording `head_sha`, `model`, `mode` (`single`/`chunked`/`budget_exhausted`/`too_large`), `intent_source`, `intent_ref`, `prompt_hash` (first 12 chars of the user-message SHA-256), and `ts`. Hidden from GitHub's rendered UI; visible via the comment's three-dots → Edit. Pair with the audit-trail JSONL to trace a surprising review back to its exact prompt.

### Secret rotation

**Zero-downtime procedure** (no dropped deliveries):

1. **Set the secondary secret and deploy.**
   Add `GITHUB_WEBHOOK_SECRET_SECONDARY=<new-secret>` to `.env` (keep `GITHUB_WEBHOOK_SECRET=<old-secret>` unchanged). Restart the bot. It now accepts both secrets. Boot log confirms: `"webhookSecondarySecret":true`.

2. **Update GitHub's webhook to the new secret.**
   In GitHub → repo/org Settings → Webhooks, change the Secret field to `<new-secret>`. GitHub immediately starts signing deliveries with the new secret. Watch the bot logs for `"evt":"webhook.secret_secondary_used"` — each occurrence confirms a delivery verified via the secondary. Once you stop seeing the secondary-used log, all in-flight deliveries have transitioned.

3. **Promote and remove the secondary secret, then deploy.**
   Set `GITHUB_WEBHOOK_SECRET=<new-secret>` and remove `GITHUB_WEBHOOK_SECRET_SECONDARY`. Restart. The rotation is complete.

> **Reminder**: complete step 3. Leaving `GITHUB_WEBHOOK_SECRET_SECONDARY` set indefinitely means both secrets remain valid indefinitely, which widens the attack surface. The secondary-used metric (`reviewme_webhook_secret_used_total{slot="secondary"}`) dropping to zero is the signal that step 3 is safe.

For non-webhook secrets (`GITHUB_PAT`, `ANTHROPIC_API_KEY`): update in the env file and restart. Log redaction scrubs PATs, Anthropic keys, JWTs, and `Bearer` tokens from any accidentally-logged payloads.

### Logs

JSON to stdout — route via journald, Fluent Bit, Vector, etc. Every log payload is scrubbed for secret patterns before serialization.

### Metrics

| Metric | Kind | Labels |
|---|---|---|
| `reviewme_webhook_received_total` | counter | `event` |
| `reviewme_webhook_secret_used_total` | counter | `slot` (`primary`/`secondary`) |
| `reviewme_webhook_replay_total` | counter | — |
| `reviewme_webhook_unknown_event_total` | counter | `event` |
| `reviewme_reviews_total` | counter | `repo`, `verdict` |
| `reviewme_review_failures_total` | counter | `stage`, `reason` |
| `reviewme_review_duration_seconds` | histogram | — |
| `reviewme_ci_wait_seconds` | histogram | — |
| `reviewme_anthropic_tokens_total` | counter | `kind` |
| `reviewme_thread_reply_total` | counter | `outcome` |
| `reviewme_thread_rate_limited_total` | counter | — |
| `reviewme_ratelimit_rejected_total` | counter | `installation` |
| `reviewme_shutdown_drain_seconds` | histogram | — |
| `reviewme_config_reload_total` | counter | `result` |
| `reviewme_prompt_cache_read_tokens_total` | counter | — |
| `reviewme_prompt_cache_creation_tokens_total` | counter | — |
| `reviewme_dead_letter_replay_total` | counter | `result` — `success` / `failure` / `skipped` |
| `reviewme_thread_resolved_skip_total` | counter | — |
| `reviewme_thread_auto_resolved_total` | counter | — |
| `reviewme_large_pr_total` | counter | `reason` — `files` / `loc` / `both` |
| `reviewme_prompt_user_bytes` | histogram | — (buckets 1KB–1MB) |
| `reviewme_implicit_skip_total` | counter | `reason` — `title` / `branch` |
| `reviewme_queue_persistence_total` | counter | `result` — `snapshot_ok` / `snapshot_failed` / `restore_ok` / `restore_failed` / `skipped_stale` |
| `reviewme_draft_skipped_total` | counter | — |
| `reviewme_breaker_state` | gauge (via counter) | `dep` — `0` closed / `1` open / `2` half-open |
| `reviewme_coverage_signal_total` | counter | `bucket` — `no_new_src` / `has_tests` / `untested` |
| `reviewme_review_cache_total` | counter | `result` — `hit` / `miss` |
| `reviewme_slash_command_total` | counter | `command` — `help` / `skip` / `resume` / `re-review` / `unknown` |
| `reviewme_budget_exhausted_total` | counter | `repo` |

Example Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: review-me
    static_configs:
      - targets: ["127.0.0.1:3000"]
    bearer_token: "<your METRICS_BIND_TOKEN>"   # omit if not set
    metrics_path: /metrics
```

### Token usage and dead letters

- Per-review token usage is appended to `var/usage/YYYY-MM.jsonl` (set `USAGE_LOG_DIR` to relocate). Summarize with `bun run scripts/usage-report.ts --since 7d`.
- Events that escape the handler land in `var/dead-letter/YYYY-MM-DD/<delivery-id>.json`. Replay with `bun run scripts/replay-dead-letter.ts <file>`.
- Prompt audit records (system prompt, user prompt, raw LLM response) land in `var/audit/YYYY-MM-DD/<owner>__<repo>_<pr>_<headSha>_<mode>.json` (set `AUDIT_LOG_DIR` to relocate, or `disabled` to turn off). Retained for `AUDIT_RETENTION_DAYS` (default 7) days; locate a specific review by repo slug, PR number, and head SHA.

---

## CI

[![CI](https://github.com/William-Long-II/review-me/actions/workflows/ci.yml/badge.svg)](https://github.com/William-Long-II/review-me/actions/workflows/ci.yml)

`.github/workflows/ci.yml` runs on every pull request and push to `main`:

1. Sets up Bun (pinned to 1.3.x).
2. Restores the Bun install cache (keyed on `bun.lock`).
3. Runs `bun install --frozen-lockfile`, `bun run typecheck`, and `bun test`.

Any non-zero exit fails the workflow.

Dependabot watches the repo for npm and GitHub Actions updates via `.github/dependabot.yml`: npm dependencies are grouped into a single weekly PR every Monday (patch + minor together; majors as separate PRs), and action versions are bumped monthly. To change the schedule or grouping, edit that file.

---

## Development

```bash
bun run dev        # watch mode
bun run start      # one-shot
bun test           # test suite (includes e2e smoke harness)
bun run typecheck  # tsc --noEmit
bun run smoke      # full e2e pipeline against in-process mocks
bun run bench      # perf benchmarks (local/manual; not wired into CI)
bun run review-pr owner/repo#123           # dry-run: fetch + build prompt + print (no LLM, no post)
bun run review-pr owner/repo#123 --with-llm  # also call Anthropic; still no post
bun run review-pr owner/repo#123 --post      # full pipeline including posting the review
bun run usage-report --since 7d              # per-repo usage; warns rows >=80% of weekly cap
```

### Project layout

```
src/
  server/    # webhook ingress, signature verify, rate limit, replay cache,
             # shutdown, metrics, dead-letter, queue, review-comment threads
  github/    # Octokit client, diff fetch (rename-aware), CI gate, review post
  jira/      # intent providers (Jira, GitHub issue, Linear) behind a common interface
  review/    # pipeline: conventions, diff filter, prompt, LLM call, chunker+synthesize
  config/    # env + repos.yaml loader with org-level defaults and SIGHUP reload
  util/      # retry with jitter, log redaction
  review/    # ...also hosts: breaker (circuit breaker), audit (prompt + response records), coverage-delta (test-coverage heuristic)
scripts/     # send-webhook, usage-report, replay-dead-letter, smoke, bench
tests/       # unit + integration + e2e, plus golden fixtures
```

### Conventions

- Structured JSON logs only — never `console.log` free-form strings. Secret patterns are redacted at the logger boundary.
- The review never emits `REQUEST_CHANGES`. Verdicts are `APPROVE` or `COMMENT`.
- Diffs above `DEFAULT_MAX_DIFF_CHARS` (150 kB of patch text) switch to chunked two-pass review (`REVIEW_MODE=auto`, default). `REVIEW_MODE=single` restores fail-open behavior.
- Dedup is keyed on `(repo, PR, head SHA, machine-user login)` — a push that changes the head SHA triggers a new review.
- Golden fixture files and test fixtures are pinned to LF line endings via `.gitattributes` so byte-for-byte comparisons don't flake on Windows checkouts.
