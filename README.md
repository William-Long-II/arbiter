# reviewme

An intent-aware GitHub pull-request review bot. Listens for webhooks, waits until CI goes green, then posts a constructive review — approving clean PRs and leaving line-level guidance on ones with issues. Never blocks a merge. Built with Bun + TypeScript; deployable on your own VMs behind an existing HTTPS reverse proxy.

## What it does

1. GitHub sends `pull_request.*` and `check_suite.completed` webhooks to `/webhook`.
2. For allowlisted repos, the bot waits until the check suite's aggregate status is green.
3. It fetches the PR diff, resolves the intent from the linked Jira ticket (or the PR description as fallback), and runs a Claude Opus 4.7 review.
4. The review is posted as a GitHub review — `APPROVE` for clean PRs, `COMMENT` with inline feedback when there's something to call out. It never uses `REQUEST_CHANGES`.
5. Per-repo config decides whether re-reviews trigger automatically on every push (`auto-on-sync`) or only when a reviewer applies a label or mentions `/reviewme` in a comment (`label-or-mention`).

## Quick start

### Prerequisites

- [Bun](https://bun.sh) 1.3+
- A dedicated **machine user account** on GitHub (real user, so reviews count toward branch protection). Give it repo access and a fine-grained PAT with PR read/write, contents read, and checks read.
- An Anthropic API key.
- Optional: a Jira Cloud API token + email for intent lookups.

### Install

```bash
bun install
cp .env.example .env
# Fill in GITHUB_PAT, GITHUB_WEBHOOK_SECRET, ANTHROPIC_API_KEY, and optionally JIRA_*
```

### Configure allowlisted repos

Edit `repos.yaml`:

```yaml
repos:
  acme/widget:
    enabled: true
    rereview: auto-on-sync
  acme/legacy-service:
    enabled: true
    rereview: label-or-mention
    rereview_label: re-review
```

Restart the bot after editing (the file is loaded at boot).

### Run

```bash
bun run dev        # watch mode
bun run start      # one-shot
bun test           # test suite
bun run typecheck  # tsc --noEmit
```

## Local testing

The bot's pipeline touches GitHub and Anthropic, so there are two useful local modes:

### Signature + routing only (no outbound calls)

Run the server and POST signed fixtures at it. The webhook endpoint verifies the signature and dispatches the event; handlers short-circuit when the repo isn't in your allowlist, so you can exercise signature verification and routing without reaching GitHub or Anthropic. Leave `repos.yaml` empty (or remove `acme/widget`) to stay in this mode.

On Windows, Bun's default bind address can behave oddly with `127.0.0.1` — set `HOSTNAME=0.0.0.0` in `.env` for local dev there.

```bash
# Terminal 1 — start the server
bun run dev

# Terminal 2 — send a signed webhook
GITHUB_WEBHOOK_SECRET=$(grep GITHUB_WEBHOOK_SECRET .env | cut -d= -f2) \
  bun scripts/send-webhook.ts ping fixtures/ping.json

GITHUB_WEBHOOK_SECRET=$(...) \
  bun scripts/send-webhook.ts check_suite fixtures/check_suite.completed.json
```

### Full pipeline against a throwaway repo

1. Create a private test repo and add the machine user as a collaborator.
2. Add it to `repos.yaml`.
3. Expose your local server with a tunnel (`cloudflared tunnel --url http://localhost:3000`, ngrok, or similar).
4. Add the tunnel URL + webhook secret to the repo's webhook settings (events: Pull requests, Check suites, Issue comments).
5. Open a PR — you'll get a real review.

## Deployment

Self-hosted on your own infrastructure. HTTPS is terminated at your existing reverse proxy (nginx/caddy/traefik); the bot binds plain HTTP internally.

### Docker

```bash
docker compose up -d --build
```

`docker-compose.yml` binds the container to `127.0.0.1:3000` so only the reverse proxy on the same host can reach it. `repos.yaml` is mounted read-only so the allowlist can be updated without rebuilding the image.

### systemd (bare metal)

```bash
# One-time setup on the host:
sudo useradd --system --home /opt/reviewme --shell /usr/sbin/nologin reviewme
sudo mkdir -p /opt/reviewme /etc/reviewme
sudo cp -r . /opt/reviewme
sudo chown -R reviewme:reviewme /opt/reviewme
sudo cp .env.example /etc/reviewme/reviewme.env    # then edit with real values
sudo chmod 600 /etc/reviewme/reviewme.env
sudo chown reviewme:reviewme /etc/reviewme/reviewme.env

# Install Bun system-wide:
curl -fsSL https://bun.sh/install | sudo bash -s -- --install-dir=/usr/local
sudo -u reviewme bash -c "cd /opt/reviewme && /usr/local/bin/bun install --frozen-lockfile --production"

# Enable the service:
sudo cp deploy/reviewme.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now reviewme
sudo journalctl -u reviewme -f
```

### Reverse proxy

Route `POST /webhook` (and optionally `/health`, `/ready`) from your public ingress to the bot. nginx example:

```nginx
location /reviewme/webhook {
    proxy_pass http://127.0.0.1:3000/webhook;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    client_max_body_size 10m;
}
```

Configure GitHub's webhook URL as `https://your-host/reviewme/webhook` and set:

- Content type: `application/json`
- Secret: matches `GITHUB_WEBHOOK_SECRET`
- Events: Pull requests, Check suites, Issue comments

## Operations

- **Health checks**: `GET /health`, `GET /ready` → `200 ok`.
- **Logs**: JSON to stdout — route via journald, Fluent Bit, Vector, etc.
- **Secret rotation**: update `GITHUB_PAT` / `ANTHROPIC_API_KEY` / `GITHUB_WEBHOOK_SECRET` in the env file and restart. Rotate the webhook secret in GitHub simultaneously (signature mismatches during the swap will 401 briefly).
- **Allowlist changes**: edit `repos.yaml` and restart. It is read once at boot; there is no hot-reload.

## Configuration reference

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` | HTTP listen port |
| `HOSTNAME` | no | `127.0.0.1` | Bind address |
| `GITHUB_PAT` | yes | — | Machine-user PAT (reviews count toward branch protection) |
| `GITHUB_WEBHOOK_SECRET` | yes | — | Shared secret for HMAC signature verification |
| `ANTHROPIC_API_KEY` | yes | — | For the Claude review pass |
| `REPOS_PATH` | no | `./repos.yaml` | Path to the allowlist file |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | no | — | Enable Jira intent lookup when all three are set |

## Development notes

- Structured logs only — never `console.log` free-form strings.
- The review never emits `REQUEST_CHANGES`. Verdicts are `APPROVE` or `COMMENT`.
- Diffs above `DEFAULT_MAX_DIFF_CHARS` (150 kB of patch text) fail open with a summary-only "too large to review automatically" comment rather than blocking or burning tokens.
- Dedup is keyed on `(repo, PR, head SHA, machine-user login)` — a push that changes the head SHA triggers a new review.
