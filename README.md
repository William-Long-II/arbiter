# review-me

An intent-aware GitHub pull-request review bot. Listens for webhooks, waits until CI goes green, then posts a constructive review — approving clean PRs and leaving line-level guidance on ones with issues. Never blocks a merge. Built with Bun + TypeScript; deployable on your own VMs behind an existing HTTPS reverse proxy.

## What it does

1. GitHub sends `pull_request.*`, `check_suite.completed`, `issue_comment.created`, and `pull_request_review_comment.created` webhooks to `/webhook`.
2. For allowlisted repos, the bot waits until the check suite's aggregate status is green.
3. It fetches the PR diff (rename-aware; lockfiles, binaries, and `linguist-generated` files stripped), resolves the intent from a pluggable provider chain (Jira → GitHub Issues → Linear, falling back to PR description), ingests the target repo's own conventions (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.cursorrules`), and runs a Claude Opus 4.7 review.
4. For large PRs the reviewer runs a two-pass summarize-then-synthesize pipeline so the bot still produces actionable feedback where it would previously have failed open.
5. The review is posted as a GitHub review — `APPROVE` for clean PRs, `COMMENT` with inline feedback when there's something to call out. It never uses `REQUEST_CHANGES`.
6. If a human replies to a bot line-comment, the bot replies once in-thread (capped at three replies per thread; `/stop` in a reply ends the thread permanently).
7. Per-repo config (with org-level defaults) decides whether re-reviews trigger automatically on every push (`auto-on-sync`) or only when a reviewer applies a label or mentions `/review-me` in a comment (`label-or-mention`).

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
| `GITHUB_WEBHOOK_SECRET` | **yes** | — | Shared secret for HMAC signature verification |
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
| `METRICS_BIND_TOKEN` | no | — | If set, `GET /metrics` requires `Authorization: Bearer <token>` |

### `repos.yaml` schema

```yaml
orgs:
  <org-name>:
    enabled: boolean          # default true
    rereview: auto-on-sync | label-or-mention
    rereview_label: string    # only meaningful for label-or-mention
    review:
      include_paths: [glob, ...]    # only review files matching; others omitted
      exclude_paths: [glob, ...]    # omit files matching these globs

repos:
  <owner/name>:
    enabled: boolean          # default true
    rereview: auto-on-sync | label-or-mention
    rereview_label: string
    review: { include_paths, exclude_paths }
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

### Secret rotation

Update `GITHUB_PAT` / `ANTHROPIC_API_KEY` / `GITHUB_WEBHOOK_SECRET` in the env file and restart. Rotate the webhook secret in GitHub simultaneously — signature mismatches during the swap will `401` briefly. Log redaction scrubs PATs, Anthropic keys, JWTs, and `Bearer` tokens from any accidentally-logged payloads.

### Logs

JSON to stdout — route via journald, Fluent Bit, Vector, etc. Every log payload is scrubbed for secret patterns before serialization.

### Metrics

| Metric | Kind | Labels |
|---|---|---|
| `reviewme_webhook_received_total` | counter | `event` |
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

---

## CI

[![CI](https://github.com/William-Long-II/review-me/actions/workflows/ci.yml/badge.svg)](https://github.com/William-Long-II/review-me/actions/workflows/ci.yml)

`.github/workflows/ci.yml` runs on every pull request and push to `main`:

1. Sets up Bun (pinned to 1.3.x).
2. Restores the Bun install cache (keyed on `bun.lock`).
3. Runs `bun install --frozen-lockfile`, `bun run typecheck`, and `bun test`.

Any non-zero exit fails the workflow.

---

## Development

```bash
bun run dev        # watch mode
bun run start      # one-shot
bun test           # test suite (includes e2e smoke harness)
bun run typecheck  # tsc --noEmit
bun run smoke      # full e2e pipeline against in-process mocks
bun run bench      # perf benchmarks (local/manual; not wired into CI)
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
scripts/     # send-webhook, usage-report, replay-dead-letter, smoke, bench
tests/       # unit + integration + e2e, plus golden fixtures
```

### Conventions

- Structured JSON logs only — never `console.log` free-form strings. Secret patterns are redacted at the logger boundary.
- The review never emits `REQUEST_CHANGES`. Verdicts are `APPROVE` or `COMMENT`.
- Diffs above `DEFAULT_MAX_DIFF_CHARS` (150 kB of patch text) switch to chunked two-pass review (`REVIEW_MODE=auto`, default). `REVIEW_MODE=single` restores fail-open behavior.
- Dedup is keyed on `(repo, PR, head SHA, machine-user login)` — a push that changes the head SHA triggers a new review.
- Golden fixture files and test fixtures are pinned to LF line endings via `.gitattributes` so byte-for-byte comparisons don't flake on Windows checkouts.
