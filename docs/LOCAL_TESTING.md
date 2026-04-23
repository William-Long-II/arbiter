# Local testing guide

A step-through for running Auto-Reviewer locally and exercising every feature against a real GitHub account. Each phase is independent — you can stop after any phase and still have a useful deployment.

The guide assumes Docker Compose. Everything here works identically with `bun run start` if you'd rather skip the container; substitute `bun install` + `bun run start` for `docker compose up`.

## Prerequisites

You need all of these before you start:

- **Docker + Docker Compose** (or `bun` 1.3+ if going container-less)
- **Claude Max subscription** logged in on the host. Run `claude /login` once; the session goes to `~/.claude`. The container mounts that directory read/write so `claude -p` uses your existing subscription instead of asking for API credits it doesn't have.
- **A bot GitHub account** (NOT your personal account). Two accounts make this much simpler: the bot posts reviews, your personal account is the one writing the PRs. Branch-protection approvals come from whoever posts the review, so reviewing your own PR from your own account defeats the point.
- **A personal access token for the bot account** with `repo` (read) and `pull_request` (read + write). Classic tokens or fine-grained both work.
- **At least one test repo** with a few open PRs. A personal repo you own is easiest — no org permissions to chase.

## Phase 1: Bare minimum (polling + basic auth)

This is the smallest working install. Boot the container, add a repo through the UI, watch the bot poll GitHub and compute a dry-run review.

### 1a. Set up `.env`

```bash
cp .env.example .env
```

Edit `.env`:
```
GITHUB_TOKEN=ghp_... (the bot account's PAT)
AUTO_REVIEWER_PASSWORD=pick-a-long-random-string
```

That's all. Leave every other variable commented out for now — we'll unlock them one phase at a time.

### 1b. Boot

```bash
docker compose up -d --build
```

Watch the logs:
```bash
docker compose logs -f auto-reviewer
```

You should see four lines:
1. `storage.opened` — sqlite file created at `./data/state.sqlite`
2. `startup.version` — build identity (`commit:"dev"` until you `docker build --build-arg COMMIT=...`)
3. `web.listening` — UI is up
4. `tick.skipped` — loop refuses to run until you finish setup

### 1c. Configure through the UI

Open `http://127.0.0.1:8787`. Basic auth prompt: username `admin`, password is whatever you put in `AUTO_REVIEWER_PASSWORD`.

On Config (`/config`):
- **Bot GitHub username**: the bot account's login (e.g. `my-review-bot`)
- **Skip authors**: add your own login (don't review your own PRs)
- **Individual repos**: `your-login/test-repo`
- Click **Save general** AND **Add repo**.

### 1d. Watch it poll

Back on the Dashboard (`/`) you'll see:
- `Mode: dry-run` (nothing posts to GitHub yet)
- `Approvals / hr: 0 / 10`
- `Next tick: Ns` countdown
- A `Currently reviewing` section that populates during a tick

In the container logs you'll see `tick.repos`, `tick.fanout`, `claude.invoke`, `claude.ok` in sequence. The Events page (`/events`) gets one row per lifecycle event.

### 1e. Verify the dry-run review

Click into **Recent reviews → detail** on the Dashboard. You'll see:
- The PR summary Claude generated
- Every line comment with severity
- "Tone used" showing the exact string Claude saw

Nothing was posted to GitHub — the PR on github.com has no review from the bot. That's dry-run doing its job.

### 1f. Flip to live

When you're happy with the dry-run output, click **Flip dry-run → live** on the Dashboard. The next tick actually posts. Reviews show up on the PR as coming from the bot account, and the `Approvals / hr` counter ticks up on approves.

## Phase 2: Large-PR triage

No setup needed — triage fires automatically on any PR crossing the thresholds in Config → General:
- `Large-PR file threshold` (default 25 files)
- `Large-PR byte threshold` (default 100 KB)

### Test it

Push a commit to your test repo that changes 30+ files (touch a bunch of trivial files). Wait for the next tick.

In the container logs:
```
triage.invoke ...
triage.ok ...
claude.invoke files:15 ... (narrowed to top-15)
```

On the review detail page you'll see a new **Large-PR triage** card listing every file with priority (high/medium/low), whether it was deep-reviewed, and Claude's one-line reason.

### Tune if needed

Lower the threshold to 5 files to trigger triage on any PR. Raise `Large-PR deep-review files` to 30 if you want wider coverage per review at the cost of one bigger prompt per PR.

## Phase 3: File-type tone templates

Give Claude file-type-specific review lenses. A `**/*.tf` pattern gets IaC-security guidance layered on; `**/*.tsx` gets a11y checks; `**/migrations/**` gets safety callouts.

### 3a. Add a template

On `/config`, scroll to **File-type tone templates → Add template**. Example for a Terraform-heavy repo:
- **Glob pattern**: `**/*.tf`
- **Priority**: `10`
- **Tone addendum**: `Review Terraform files with IaC security in mind: state locks, plan review, hardcoded secrets, IAM blast radius.`

Click **Create**.

### 3b. Verify it fires

Re-review a PR that touches a `.tf` file (hit the **Re-review this SHA** button on its detail page). The detail page now shows a **Tone templates fired** card with the pattern and matched files. The **Tone used** card shows the template's text layered after the default tone.

Higher-priority templates appear later in the final tone (closer to the TASK instruction), so specificity wins.

## Phase 4: Ticket-aware reviews (Jira / Linear / GitHub issues)

GitHub issues are free — any `#123` or `other-org/repo#456` reference in the PR title or body pulls the issue into Claude's prompt. Jira and Linear need per-org credentials.

### 4a. GitHub issues (no setup)

Open a PR titled "Fix the thing (closes #7)" where #7 is a real issue on the same repo. The review-detail page shows a **Linked tickets** card with the issue title + url, and Claude's summary will judge the patch against what the issue asked for.

### 4b. Jira

On `/config/orgs/<your-org>/edit`:
- **Host**: `https://your-org.atlassian.net`
- **Email**: your Atlassian email
- **API token**: create one at `id.atlassian.com/manage-profile/security/api-tokens`

Now PRs mentioning `PROJ-123` in the title or body pull the Jira ticket's summary + description + comments into the prompt.

### 4c. Linear

Same path, Linear tab:
- **API key**: create one at `linear.app/settings/api`

PRs referencing `ENG-45` or `OPS-123` now pull the Linear ticket.

Linear and Jira can coexist in the same org. An identifier that happens to exist in both is fetched from both and presented side-by-side.

## Phase 5: Threaded replies

When enabled, the bot sees replies to its own line comments and responds in-thread with the diff still in context. Off by default because it costs an extra Claude call per pending thread.

### 5a. Enable

Config → General → **Threaded replies** → `true`. Save.

### 5b. Test

Wait for the bot to review a PR and post at least one line comment. On GitHub, **reply** to one of those comments (e.g. "why is this an issue?"). Wait for the next tick.

In the container logs:
```
threads.invoke ... chainLength:2
threads.replied ...
```

The reply shows up on GitHub in the same thread. You can keep the conversation going — one bot reply per new human reply, forever.

To test the quota guard: flip `Max approvals / hour` to 1 temporarily. The first thread reply eats the quota; the second emits `threads.rate_limited` and defers.

## Phase 6: Webhook ingest (instant response)

Polling has up-to-poll-interval latency. Webhooks bring it under a second.

You need to expose `/webhook/github` to the internet. The easiest, no-firewall-hole path is a **Cloudflare Tunnel** sidecar — already stubbed in `docker-compose.yml`. Alternatives: `ngrok`, a reverse proxy on a VPS, anything that terminates HTTPS.

### 6a. Set the secret

Pick a long random string, set it in `.env`:
```
GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)   # example
```

Restart: `docker compose restart auto-reviewer`.

### 6b. Expose `/webhook/github` (Cloudflare Tunnel example)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → Zero Trust → Networks → Tunnels → Create
2. Pick a hostname (e.g. `reviewer.your-domain.com`)
3. Route: Service `http://auto-reviewer:8787`
4. Copy the tunnel token into `.env`:
   ```
   CLOUDFLARE_TUNNEL_TOKEN=eyJ...
   ```
5. Uncomment the `cloudflared` service in `docker-compose.yml` and re-run `docker compose up -d`.

### 6c. Configure the GitHub webhook

On your test repo → Settings → Webhooks → Add webhook:
- **Payload URL**: `https://<your-tunnel-hostname>/webhook/github`
- **Content type**: `application/json`
- **Secret**: same value as `GITHUB_WEBHOOK_SECRET`
- **Events**: check **Pull requests**, **Pull request review comments**, **Check suites**
- **Active**: yes

GitHub will send a `ping`. You should see `webhook.ignored` (we only act on PR events) in logs — that proves the signature verified.

### 6d. Test

Push a commit to a branch with an open PR. The `pull_request.synchronize` event lands within a second:
```
webhook.enqueued repo=... pr=... action=synchronize
tick.repos count=1
claude.invoke ...
```

If you enabled threaded replies (Phase 5), reply to a bot comment — you get an instant `webhook.thread_enqueued` and the threaded response lands before the next poll would have fired.

## Phase 7: GitHub OAuth (multi-user)

Upgrade from the single shared password to real per-user sessions. The first GitHub user to sign in becomes admin; subsequent logins start as viewer until promoted.

Only do this if you have an exposed hostname — the OAuth callback must be reachable from github.com. If you're loopback-only, skip this phase.

### 7a. Register the OAuth app

[github.com/settings/developers](https://github.com/settings/developers) → New OAuth App:
- **Homepage URL**: `https://<your-hostname>`
- **Authorization callback URL**: `https://<your-hostname>/auth/github/callback`

Copy the **Client ID** (harmless — goes in the DB) and **Client Secret** (secret — goes in env only, never in the DB).

### 7b. Wire it

Edit `.env`:
```
GITHUB_OAUTH_CLIENT_SECRET=...
```

On `/config`, paste the client id into **GitHub OAuth App client id** and save.

Restart: `docker compose restart auto-reviewer`.

### 7c. First login

Visit `https://<your-hostname>/`. Instead of the basic-auth prompt, you get a redirect to GitHub. Authorize → land on the Dashboard as admin (auto-promoted since the users table was empty).

Notice the header: login + `admin` tag + logout button.

### 7d. Second user + role management

Have a second GitHub user sign in via the same flow. They land as viewer:
- Dashboard / Events / Config pages still load
- Every POST returns 403 ("Forbidden: admin role required")

As admin, go to `/config/users` → click **promote to admin** on the second user. Their existing session keeps working; they can now mutate config.

### 7e. Demote / delete safety

- **Self-demote and self-delete are blocked** — admins can't accidentally lock themselves out.
- Demoting another admin to viewer **wipes their live sessions** so they can't keep posting config changes until the cookie TTL expires.

## Phase 8: Operations surface

This is what you actually hit from a shell or a monitoring system.

### 8a. `/healthz`

```bash
curl -s http://127.0.0.1:8787/healthz | jq .
```

```json
{
  "status": "ok",
  "checks": {
    "sqlite":     { "ok": true },
    "integrity":  { "ok": true, "detail": "ok (last checked at boot)" },
    "loop":       { "ok": true, "detail": "last tick 12s ago" },
    "breaker":    { "ok": true, "kind": "closed" },
    "configured": { "ok": true }
  }
}
```

- `status: "down"` + HTTP 503 → sqlite is actually broken OR `PRAGMA integrity_check` failed at boot. Restore from backup.
- `status: "degraded"` + HTTP 200 → process is fine but something needs attention. Read `detail` on each check.
- `status: "ok"` + HTTP 200 → everything's green.

The Docker image's `HEALTHCHECK` directive hits this automatically every 30s.

### 8b. `/api/version`

```bash
curl -s http://127.0.0.1:8787/api/version | jq .
```

```json
{ "version": "0.1.0", "commit": "abc1234", "built_at": "2026-04-23T..." }
```

`commit` is `"dev"` until you build with `--build-arg COMMIT=$(git rev-parse HEAD)`. The same info shows in the footer of every UI page.

### 8c. Backup (one-click)

From the UI: Dashboard → Storage card → **Download backup (.sqlite)**. Admin-only.

From curl (useful for scripting):
```bash
curl -u admin:$AUTO_REVIEWER_PASSWORD http://127.0.0.1:8787/api/backup \
  -o "auto-reviewer-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
```

The file is a consistent online snapshot via `VACUUM INTO`. Copy it anywhere — that's your recovery point.

For recurring backups, schedule `scripts/backup.sh` from cron. It captures the DB + `config.yaml` (if present) + a manifest, tarballs the lot, and drops it in `./backups/`.

### 8d. Restore

```bash
./scripts/restore.sh ./backups/auto-reviewer-20260423T141500Z.tar.gz
```

Unpacks, stops the container, swaps in the backed-up DB, restarts. No data migration needed — backup is the whole DB.

### 8e. Integrity-failure drill (destructive — use a test DB)

Simulate corruption to confirm the safety net works:
```bash
docker compose stop auto-reviewer
# Clobber a few bytes inside the DB's page region.
# DO NOT run this on a DB you care about.
dd if=/dev/urandom of=data/state.sqlite bs=1 count=100 seek=4096 conv=notrunc
docker compose start auto-reviewer
```

You'll see:
1. `storage.integrity_failed` event (error level) in `docker compose logs`
2. Red banner on the Dashboard Storage card
3. `/healthz` returns HTTP 503 with `integrity.ok: false`

The process keeps running — so you can still use the UI to inspect state and download `/api/backup`. Restore from a good backup via `scripts/restore.sh` and restart.

### 8f. Rate limits

- **GitHub PAT**: look at the Dashboard's **GitHub API** stat. It updates after every REST call with `remaining / limit · reset Nm`. When the number drops fast, one of your orgs has more repos/PRs than expected.
- **Webhook ingress**: the per-IP limiter enforces 120-burst + 2/sec sustained. Legitimate GitHub traffic never hits it; a scanner does. Events fire as `webhook.rate_limited`.
- **Approvals**: `Approvals / hr` on the Dashboard. Caps are `max_approvals_per_hour` in Config → General.

## Phase 9: Tearing it down

```bash
docker compose down         # stops + removes container (keeps ./data)
docker compose down -v      # stops + removes, BUT also wipes named volumes.
                            # Our data is in a bind mount (./data), NOT a
                            # named volume, so ./data survives either way.
rm -rf data backups         # full nuclear reset if you want a fresh start
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `storage.opened freshlyCreated:true` on every boot | `./data` bind mount not working — see README's **Troubleshooting** section |
| `/healthz` says `loop.ok: false, "no tick since boot"` | Config isn't complete (need `bot_username` + at least one repo) |
| `/healthz` says `breaker: open` | Several `claude.failed` events in a row. Check `docker compose logs` for stderr; often a Max session expiry. `claude /login` on the host |
| Webhook returns 401 | HMAC mismatch — regenerate the secret and paste it into both `.env` and the GitHub webhook config |
| Webhook returns 503 | `GITHUB_WEBHOOK_SECRET` is unset in the container's env |
| OAuth callback loop | Callback URL registered with GitHub doesn't match `<your-host>/auth/github/callback`, or client id in `/config` doesn't match the registered app |
| First GitHub user NOT auto-promoted to admin | The users table wasn't empty. Happens if a previous login attempt partially succeeded. Wipe `./data/state.sqlite` if this is a clean install; otherwise use SQL to set role manually |
