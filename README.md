# Auto-Reviewer for PRs

A self-hosted, Dockerized service that watches GitHub for pull requests you did not author, waits for CI to pass, and posts a per-line code review using your existing Claude **Max** plan via `claude -p`. No Anthropic API billing. Poll-by-default; optional webhook ingest for instant response. Optional threaded follow-up when reviewers reply to the bot's comments.

A small web UI (default `http://127.0.0.1:8787`) shows what the bot has done, lets you edit configuration live, and lets you force a re-review without restarting the container.

## Mission

You run it on your own box against the repos and orgs you care about. When someone opens a PR, it reads the diff, fetches the linked issue / ticket for context, runs a Max-plan Claude pass, and leaves specific, line-attached comments that explain **why** an issue matters and **how** to fix it — then approves when there's nothing blocking and CI is otherwise clean.

## Feature highlights

- **Polling + optional webhooks.** Poll is the default (runs behind NAT with zero inbound access). Point a GitHub webhook at `/webhook/github` with HMAC verification to skip the polling wait. Pair with a Cloudflare Tunnel sidecar to expose the endpoint without opening firewall ports.
- **Large-PR triage.** On PRs above a file-count or byte-diff threshold, a cheap first-pass classifies every file by priority; only the top-N get the full review prompt. Two Claude calls per huge PR instead of one generic pass.
- **Ticket-aware reviews.** Linked GitHub issues, Jira tickets, and Linear tickets are fetched automatically from the PR title/body and included in the review prompt, so the bot reviews against what was asked for, not just code quality.
- **Per-file-type tone templates.** Glob-matched addendums layer onto the review tone: Terraform files get IaC-security guidance, React components get a11y checks, migrations get safety callouts.
- **Threaded iteration.** When enabled, the bot sees replies to its own line comments and responds in-thread with the diff still in context. One back-and-forth per human reply per tick.
- **GitHub OAuth + roles.** Multi-user deployments upgrade from single-password basic auth to session-based GitHub login. First user becomes admin; subsequent users start as viewer until promoted.
- **Circuit breaker + dead-letter queue.** Consecutive Claude failures trip a system-wide breaker that cools off before trying again, protecting your Max quota. Per-PR failure counters dead-letter stuck PRs for operator attention instead of retrying them forever.
- **Dry-run by default.** First boot logs what it *would* have posted. Flip it in the UI when you trust it.
- **Idempotent.** SQLite tracks `(repo, pr_number, head_sha)`. A new push re-triggers review; an unchanged push doesn't.
- **Config in sqlite, editable in the UI.** No file-edit + restart loop to add a repo or tweak the tone.

## How it works

```
                   ┌─ webhook (signed, optional) ─┐
                   │                              │
poll GitHub ───────┼────────┐                     │
                   │        ▼                     ▼
                   │   eligible PR ◄──────────────┘
                   │        │
filter (not-me, not-draft, not-bot, not-dead-lettered)
                            │
                            ▼
                    CI checks green?
                            │ yes
                            ▼
                       fetch diff
                            │
                            ▼
                    resolve linked tickets
                 (GitHub / Jira / Linear)
                            │
                            ▼
                   large PR? run triage pass
                   and narrow file set
                            │
                            ▼
                   apply tone + file-type templates
                            │
                            ▼
                     claude -p  (Max plan)
                            │
                            ▼
              validate line-comments vs hunks
                            │
                            ▼
                    post review + record SHA
              (APPROVE or REQUEST_CHANGES)
                            │
                            ▼
        [next tick] scan for new replies on bot
         comments and iterate via claude -p
           (threaded_replies=true only)
```

- **Claude Max via CLI.** Mounts `~/.claude` into the container so `claude -p` uses your existing subscription.
- **Per-line reviews.** Claude returns structured JSON; comments on lines that aren't inside a diff hunk are folded into the summary instead of being dropped silently.

## Prerequisites

- Docker + Docker Compose
- A Claude Max subscription logged in on the host (`claude /login` — the session file goes to `~/.claude`)
- A GitHub personal access token for the **bot account** (not your personal account). Scopes: `repo` read, `pull_request` write. The bot user is who the review appears from, and is what satisfies branch-protection approvals.

## Setup

```bash
cp .env.example .env             # set GITHUB_TOKEN
docker compose up -d --build
open http://127.0.0.1:8787       # configure in the browser
```

On first boot the DB is empty. Open the UI, set **Bot username**, add the orgs/repos you want watched, and the loop starts running. Everything else (tone, skip authors, file filters, rate limits, concurrency, large-PR thresholds, threaded replies, OAuth client id) is editable from `/config`.

### Optional: bootstrap from a YAML file

If you prefer to seed settings from a file on first boot, drop a `config.yaml` next to `docker-compose.yml` using the shape in `config.example.yaml`. At first startup, if the DB has no bot_username set AND `config.yaml` exists, the values are imported into sqlite and the file is ignored from then on. The **UI is the source of truth** after import.

### Optional: webhook ingest for instant reviews

1. Set `GITHUB_WEBHOOK_SECRET` in `.env` to any long random string.
2. In the GitHub repo (or App) webhook config: URL = `https://<your-host>/webhook/github`, content-type = `application/json`, secret = same value. Subscribe to **Pull requests**, **Pull request review comments**, and **Check suites** (first is required; the other two enable instant threaded-reply iteration and immediate re-review when CI turns green).
3. Expose the endpoint. Easiest path: uncomment the `cloudflared` sidecar in `docker-compose.yml`, set `CLOUDFLARE_TUNNEL_TOKEN` in `.env`, and route the tunnel at `auto-reviewer:8787` in the Cloudflare dashboard.

The endpoint 401s on a bad signature, 200-no-ops on duplicate deliveries, and 503s if the secret isn't set — so it fails closed when misconfigured. Polling keeps running regardless; webhooks just wake the loop early instead of waiting out the poll interval.

### Optional: GitHub OAuth for multi-user deployments

1. Create an OAuth App at [github.com/settings/developers](https://github.com/settings/developers) with callback `https://<your-host>/auth/github/callback`.
2. Paste the client id into `/config` → **GitHub OAuth App client id**.
3. Set `GITHUB_OAUTH_CLIENT_SECRET` in `.env` to the client secret (not in the DB — a snapshot must never leak it).
4. Restart the container. The UI now redirects unauthenticated requests to `/auth/github/login`.
5. The first GitHub user to sign in is auto-promoted to admin. Subsequent logins arrive as viewer. Admins manage roles on `/config/users`.

Basic auth (`AUTO_REVIEWER_PASSWORD`) and OAuth are mutually exclusive; if the OAuth client id is empty the UI stays on basic auth.

### Optional: Jira / Linear intent providers

For PRs whose title or body reference a Jira (`PROJ-123`) or Linear (`ENG-45`) ticket, you can have the bot fetch the ticket's summary + description and include it in the review prompt so reviews judge against what the ticket asked for.

Per-org setup on `/config/orgs/<org>/edit`:
- **Jira**: paste host (`https://your-org.atlassian.net`), your Atlassian email, and an API token from `id.atlassian.com/manage-profile/security/api-tokens`.
- **Linear**: paste an API key from `linear.app/settings/api`.

Credentials are per-org (so different tenants can coexist); the API token is never logged or echoed in audit events.

## The UI

- **Dashboard** (`/`) — current mode (dry-run vs live), approvals in the last hour vs cap, watched-entry count, poll interval, last-tick timestamp, storage health, recent reviews, and any dead-lettered PRs needing attention. Flip dry-run from here.
- **Config** (`/config`) — everything editable: bot username, OAuth client id, skip-authors, tone, include/exclude path globs, rate limit + concurrency + dead-letter threshold, large-PR triage thresholds, threaded-replies toggle, webhook + OAuth info cards, watched orgs + repos, file-type tone templates.
- **Config → Users** (`/config/users`, admin only, OAuth mode) — list users, promote/demote, delete.
- **Events** (`/events`) — last 200 lifecycle events: CI failures, Claude errors, post errors, config saves, dry-run flips, rate-limit blocks, webhook deliveries, OAuth logins, audit trail for every config mutation with actor + before/after.
- **Review detail** — full summary, every per-line comment with severity, dropped comments (that Claude attached outside the diff), large-PR triage outcome when it ran, linked tickets, tone templates that fired, and the exact tone string sent to Claude. A "Re-review this SHA" button clears the dedupe row so the next tick picks the PR up again.

The server binds to `127.0.0.1:8787` on the host by default. If you leave it on loopback and haven't set OAuth, no auth is needed. If you bind to anything else, set either `AUTO_REVIEWER_PASSWORD=...` (single-operator basic auth) or configure OAuth (multi-user sessions). `/healthz` and `/webhook/github` are always open — webhook authenticates via HMAC.

## Safety rails

- **Dry run is the default.** Nothing posts until you turn it off.
- **Approval rate limit.** `max_approvals_per_hour` caps how many approving reviews the bot can post in a rolling hour. Thread-reply posts count against the same bucket.
- **Circuit breaker.** After N consecutive `claude.failed` events the breaker opens; Claude calls are skipped for a cooldown window (default 15 minutes), then a single trial request probes the quota before closing or re-opening. Protects your Max subscription from burning a 5-hour cooldown on a bad run.
- **Dead-letter queue.** After N consecutive failures on the same PR+SHA, the PR is skipped until an operator clicks **Retry** or **Dismiss** from the Dashboard. No runaway retry loop on a single broken PR.
- **CI gate.** `require_ci_green` (default on) skips PRs whose non-approval checks are pending or failing.
- **Self-skip and author-skip.** The bot username is always excluded from review targets. Add your own login to `skip_authors` so it doesn't review your PRs either. Dependabot / renovate / github-actions are skipped by default via `skip_bots`.
- **Drafts.** Skipped by default.
- **File filters.** Glob-based include / exclude applied before Claude sees the diff. Seeded on first boot with common lockfiles, `node_modules/**`, `dist/**`, minified assets — editable in the UI.
- **Role-based access** (OAuth mode). Viewers can read everything but cannot post to any `/config/*` or `/actions/*` route. Self-demote and self-delete are blocked so an admin can't lock themselves out.
- **Same-origin POST guard.** The UI refuses POSTs whose `Origin` header isn't the server itself, which blunts most CSRF even when auth is off.
- **Webhook signature verification.** HMAC-SHA256 on every incoming delivery; bad signatures are 401'd and logged. Missing secret → 503 (fails closed, never accepts anonymous posts).
- **Session cookies.** HttpOnly + SameSite=Lax + Secure-when-HTTPS. Session tokens are SHA-256'd at rest; the raw token only exists in the cookie, so a DB dump doesn't grant impersonation.
- **Events + webhook-delivery retention.** `AUTO_REVIEWER_EVENT_RETENTION_DAYS` (default 30) and `AUTO_REVIEWER_WEBHOOK_RETENTION_DAYS` (default 14) prune old rows at startup so the tables stay bounded.
- **Audit trail.** Every config change + role change records an event with actor, target, and structured before/after. Actor is the session GitHub login when OAuth is on; otherwise the `AUTO_REVIEWER_OPERATOR` env var, otherwise `operator`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | *required* | PAT for the bot account that will post reviews. |
| `GITHUB_OAUTH_CLIENT_SECRET` | empty | When set + `github.oauth_client_id` in DB, switches UI auth to GitHub OAuth. |
| `GITHUB_WEBHOOK_SECRET` | empty | Enables `POST /webhook/github`; must match the GitHub webhook's secret. |
| `AUTO_REVIEWER_PASSWORD` | empty | Shared-password HTTP basic auth (ignored when OAuth is on). |
| `AUTO_REVIEWER_OPERATOR` | `operator` | Audit-log actor name when no OAuth session is present. |
| `AUTO_REVIEWER_DB` | `./data/state.sqlite` | SQLite file path. |
| `AUTO_REVIEWER_CONFIG` | `./config.yaml` | One-time YAML bootstrap path. |
| `AUTO_REVIEWER_WEB_HOST` | `127.0.0.1` | Bind host. Set to `0.0.0.0` inside Docker. |
| `AUTO_REVIEWER_WEB_PORT` | `8787` | Bind port. |
| `AUTO_REVIEWER_EVENT_RETENTION_DAYS` | `30` | Prune `events` older than this at boot. |
| `AUTO_REVIEWER_WEBHOOK_RETENTION_DAYS` | `14` | Prune `webhook_deliveries` older than this at boot. |
| `AUTO_REVIEWER_BREAKER_THRESHOLD` | `5` | Consecutive `claude.failed` events that trip the breaker. |
| `AUTO_REVIEWER_BREAKER_COOLDOWN_SECONDS` | `900` | Seconds the breaker stays open before probing. |

All other configuration lives in the SQLite DB and is edited through the UI.

## Development

```bash
bun install
bun test            # ~270 tests (`bun:test`) across pure functions + state CRUD
bun run typecheck
bun run start       # GITHUB_TOKEN required; UI at http://127.0.0.1:8787
```

## Layout

```
src/
  config.ts              zod-validated Config; loads from sqlite, bootstraps from yaml once
  log.ts                 JSON log lines
  audit.ts               audit action types + currentActor resolution
  metrics.ts             time-bucketed review/event counters for the /api/metrics endpoint
  loop.ts                runTick: discover + CI + triage + tone-template + claude + validate + post; then threaded-reply sweep
  index.ts               startup, bootstrap, web server, loop, signals

  github/                Octokit wrappers
    client.ts            Octokit factory
    discover.ts          org→repo resolution, PR listing, author filter
    ci.ts                check-runs + commit-status (approval checks ignored)
    diff.ts              PR files + hunk parser (validates comment lines)
    slug.ts              owner/name URL helpers

  claude/
    prompt.ts            review + triage + reply prompts
    schema.ts            zod schemas for each response JSON
    invoke.ts            Bun.spawn of `claude -p`; generic invokeClaudeJson<T>

  review/
    validate.ts          drops comments outside hunks → folds into summary
    post.ts              posts review via Octokit (APPROVE / REQUEST_CHANGES)
    tone.ts              default → org → repo tone resolution
    tone-templates.ts    per-file-type addendum matcher
    file-filter.ts       include/exclude glob filtering
    large-pr.ts          shouldTriage + pickDeepReviewFiles
    breaker.ts           circuit breaker state machine (closed/open/half-open)

  intent/                linked-ticket context for the prompt
    resolve.ts           title/body extractor + per-org dispatcher
    github.ts            linked GitHub issues + PRs
    jira.ts              Jira REST v3 + ADF body flattener
    linear.ts            Linear GraphQL

  threads/               threaded reply iteration (#136)
    detect.ts            pure findPendingReplies (which bot comments need a reply)
    respond.ts           list comments → invoke Claude → post reply → update watermark

  webhook/               GitHub webhook ingest (#135)
    verify.ts            HMAC-SHA256 constant-time check
    extract.ts           pull_request payload → {repo, number, head_sha}

  auth/                  session + OAuth (#137)
    session.ts           token mint/hash, cookie serialize/parse
    oauth.ts             authorize URL + code exchange + /user fetch

  state/
    db.ts                sqlite schema + CRUD for every table

  web/
    html.ts              tagged-template HTML with auto-escape
    layout.ts            shared layout + dark CSS
    runtime.ts           shared status (last tick, webhook queue, breaker) for the UI
    server.ts            Bun.serve + router + auth middleware + same-origin guard
    auth.ts              basic-auth handler (used when OAuth isn't configured)
    routes/
      dashboard.ts       GET /
      status-api.ts      GET /api/status (live poll)
      metrics-api.ts     GET /api/metrics (dashboard charts)
      review-detail.ts   GET /reviews/:owner/:name/:pr
      config.ts          GET /config + POST /config/{general,orgs,repos}
      org-edit.ts        GET/POST /config/orgs/:name/edit + intent credentials
      repo-edit.ts       GET/POST /config/repos/:owner/:name/edit
      tone-template-edit.ts   GET/POST /config/tone-templates[/:id]
      users.ts           GET /config/users + role / delete POSTs
      auth.ts            GET /auth/github/{login,callback}; POST /auth/logout
      webhook.ts         POST /webhook/github
      events.ts          GET /events
      actions.ts         POST /actions/{toggle-dry-run,recheck,retry-failure,dismiss-failure}

tests/                   bun:test (~270 tests (`bun:test`))
```

## Troubleshooting: state disappears between restarts

If your configured orgs/repos/settings vanish every time you restart the container, the `./data` bind mount isn't persisting. The Dashboard shows a **Storage** card with the DB path, file size, and row counts — and a red banner if the DB file was created fresh on this boot instead of being reused.

Check in order:

1. **Run `docker compose up` from the repo root.** The `./data` path in `docker-compose.yml` is relative to wherever you invoke compose. Invoking from a different cwd points at a different `./data`.
2. **Don't pass `--volumes` or `-v` to `docker compose down`.** That removes named volumes (and can blow away bind-mount contents depending on Docker version). Plain `docker compose down` + `docker compose up` preserves the bind.
3. **Confirm the mount is correct:** `docker inspect auto-reviewer --format '{{json .Mounts}}'` should show a bind mount for `/app/data` pointing at your host `./data` directory.
4. **Confirm the host directory has contents after the container ran:** `ls -la data/` should show `state.sqlite` (and a `state.sqlite-wal` + `state.sqlite-shm` while the container runs). If the file is there but the DB is fresh next boot, the container is pointing somewhere else.
5. **Permissions.** The container runs as UID 1000 (`bun`). If the host directory is root-owned and read-only for 1000, sqlite can't write — and each reboot starts clean. `chown 1000:1000 data/` on Linux; on Windows with Docker Desktop this is usually a non-issue but worth verifying if the startup log says `storage.opened freshlyCreated=true` every boot.

The startup log prints one JSON line summarizing state:

```json
{"msg":"storage.opened","path":"/app/data/state.sqlite","freshlyCreated":false,"sizeKB":"45.2","reviews":12,"events":203,"orgs":1,"repos":3,"skip_authors":2}
```

`freshlyCreated:true` on every boot is the unambiguous signal the mount isn't working.

## Known limits / non-goals

- **Max plan only.** If your Max session expires, `claude -p` fails, the breaker opens, and the bot logs an error. It does not fall back to the Anthropic API.
- **No runtime code execution.** Reviews are based on the diff + linked ticket text only. The bot doesn't clone the repo, run tests, or evaluate the patch.
- **No multi-tenancy inside one DB.** One bot account, one sqlite file. If you need separate review pools, run separate containers with separate `./data` directories.
- **No in-tree secrets encryption.** Sessions hash at rest, intent-provider API tokens do not. Put the sqlite file on an encrypted volume if that matters; don't snapshot `./data` into a backup bucket without thinking about it.
