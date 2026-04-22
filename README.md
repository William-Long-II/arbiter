# Auto-Reviewer for PRs

A small, locally-dockerized service that polls GitHub for pull requests you did not author, waits until CI is green, and posts a per-line code review using your existing Claude **Max** plan via `claude -p`. No Anthropic API billing. No webhooks. No public endpoint needed.

A small web UI (default `http://127.0.0.1:8787`) shows what the bot has done, lets you edit configuration live, and lets you force a re-review without restarting the container.

## Mission

Auto-Reviewer for PRs. You run it on your own box against the repos and orgs you care about. When someone opens a PR, it reads the diff, runs a Max-plan Claude pass, and leaves specific, line-attached comments that explain **why** an issue matters and **how** to fix it — then approves when there's nothing blocking and CI is otherwise clean.

## How it works

```
poll GitHub ─► filter (not-me, not-draft) ─► CI green? ─► fetch diff
     │                                                        │
     └───── already reviewed this SHA? skip ◄────┐            ▼
                                                 │    claude -p  (Max plan)
                                                 │            │
                                                 │            ▼
                                                 │    validate line-comments
                                                 │    against diff hunks
                                                 │            │
                                                 │            ▼
                                                 └── post review  ──► record SHA
                                                     (APPROVE or REQUEST_CHANGES)
```

- **Polling, not webhooks.** Runs behind your home/office NAT with no inbound access.
- **Claude Max via CLI.** Mounts `~/.claude` into the container so `claude -p` uses your existing subscription instead of API credits.
- **Per-line reviews.** Claude returns structured JSON; comments on lines that aren't inside a diff hunk are folded into the summary instead of being dropped silently.
- **Dry-run by default.** First boot logs what it *would* have posted. Flip it in the UI when you trust it.
- **Idempotent.** SQLite tracks `(repo, pr_number, head_sha)`. A new push re-triggers review; an unchanged push doesn't.
- **Config in sqlite, editable in the UI.** No file-edit + restart loop to add a repo or tweak the tone.

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

On first boot the DB is empty. Open the UI, set **Bot username**, add the orgs/repos you want watched, and the loop starts running.

### Optional: bootstrap from a YAML file

If you prefer to seed settings from a file on first boot (e.g. keeping them in config management), drop a `config.yaml` next to `docker-compose.yml` using the shape in `config.example.yaml`. At first startup, if the DB has no bot_username set AND `config.yaml` exists, the values are imported into sqlite and the file is ignored from then on. The **UI is the source of truth** after import.

## The UI

Three pages:

- **Dashboard** (`/`) — current mode (dry-run vs live), approvals-in-the-last-hour vs cap, watched-entry count, poll interval, last-tick timestamp, and a table of recent reviews. Flip dry-run from here.
- **Config** (`/config`) — edit everything: bot username, skip-authors, tone, dry-run, rate limit, poll interval, Claude command/timeout, watched orgs (mode `all` or `include` with comma-separated include/exclude), and individual `owner/name` repos.
- **Events** (`/events`) — last 200 lifecycle events: CI failures, Claude errors, post errors, config saves, dry-run flips, rate-limit blocks.

Each review row links to a detail page showing the full summary, every per-line comment with severity, and any comments that had to be dropped because Claude attached them to lines outside the diff hunks. A "Clear dedupe" button on the detail page makes the next tick re-review the same SHA.

The server binds to `127.0.0.1:8787` on the host by default. If you leave it on loopback, no auth is needed. If you bind to anything else (reverse-proxy it for remote access, expose it on a VPN, etc.), set `AUTO_REVIEWER_PASSWORD=something` to enable HTTP Basic auth — the browser will prompt automatically. Username is fixed to `admin`. `/healthz` is always open so Docker healthchecks and reverse proxies work without credentials.

## Safety rails

- **Dry run is the default.** Nothing posts until you turn it off.
- **Approval rate limit.** `max_approvals_per_hour` caps how many approving reviews the bot can post in a rolling hour.
- **CI gate.** `require_ci_green` (default on) skips PRs whose non-approval checks are pending or failing.
- **Self-skip.** The bot username is always excluded from review targets. Add your own login to `skip_authors` so it doesn't review your PRs either.
- **Drafts.** Skipped by default.
- **Same-origin POST guard.** The UI refuses POSTs whose `Origin` header isn't the server itself, which blunts most CSRF even without auth.
- **Optional Basic auth.** Set `AUTO_REVIEWER_PASSWORD` to require a password before any UI route works. Unset means loopback-only trust.
- **Events retention.** `AUTO_REVIEWER_EVENT_RETENTION_DAYS` (default 30) prunes old event rows at startup so the table stays bounded.

## Development

```bash
bun install
bun test            # diff hunk parser, JSON extractor, review validator, config store
bun run typecheck
bun run start       # GITHUB_TOKEN required; UI at http://127.0.0.1:8787
```

## Layout

```
src/
  config.ts              zod-validated Config; loads from sqlite, bootstraps from yaml once
  log.ts                 JSON log lines
  github/
    client.ts            Octokit factory
    discover.ts          org→repo resolution, PR listing, author filter
    ci.ts                check-runs + commit-status (approval gates ignored)
    diff.ts              PR files + hunk parser (validates comment lines)
  claude/
    prompt.ts            prompt template
    schema.ts            zod schema for the review JSON
    invoke.ts            Bun.spawn of `claude -p`, extracts JSON, validates
  review/
    validate.ts          drops comments outside hunks → folds into summary
    post.ts              posts review via Octokit (APPROVE / REQUEST_CHANGES)
  state/
    db.ts                sqlite: reviews, events, config_* tables (all CRUD)
  web/
    html.ts              tagged-template HTML with auto-escape
    layout.ts            shared layout + dark CSS
    runtime.ts           shared status (last tick, errors) for the UI
    server.ts            Bun.serve + router + same-origin guard
    routes/
      dashboard.ts       GET /
      review-detail.ts   GET /reviews/:owner/:name/:pr
      config.ts          GET /config + POST /config/{general,orgs,repos}
      events.ts          GET /events
      actions.ts         POST /actions/{toggle-dry-run,recheck}
  loop.ts                one tick: discover → CI → claude → validate → post
  index.ts               startup, bootstrap, web server, loop, signals

tests/                   bun:test
```

## Troubleshooting: state disappears between restarts

If your configured orgs/repos/settings vanish every time you restart the container, the `./data` bind mount isn't persisting. The Dashboard now shows a **Storage** card with the DB path, file size, and row counts — and a red banner if the DB file was created fresh on this boot instead of being reused.

Check in order:

1. **Run `docker compose up` from the repo root.** The `./data` path in `docker-compose.yml` is relative to wherever you invoke compose. Invoking from a different cwd points at a different `./data`.
2. **Don't pass `--volumes` or `-v` to `docker compose down`.** That removes named volumes (and can blow away bind-mount contents depending on Docker version). Plain `docker compose down` + `docker compose up` preserves the bind.
3. **Confirm the mount is correct:** `docker inspect auto-reviewer --format '{{json .Mounts}}'` should show a bind mount for `/app/data` pointing at your host `./data` directory.
4. **Confirm the host directory has contents after the container ran:** `ls -la data/` should show `state.sqlite` (and a `state.sqlite-wal` + `state.sqlite-shm` while the container runs). If the file is there but the DB is fresh next boot, the container is pointing somewhere else.
5. **Permissions.** The container runs as UID 1000 (`bun`). If the host directory is root-owned and read-only for 1000, sqlite can't write — and each reboot starts clean. `chown 1000:1000 data/` on Linux; on Windows with Docker Desktop this is usually a non-issue but worth verifying if the startup log says `storage.opened freshlyCreated=true` every boot.

The startup log also prints one JSON line summarizing state:
```json
{"msg":"storage.opened","path":"/app/data/state.sqlite","freshlyCreated":false,"sizeKB":"45.2","reviews":12,"events":203,"orgs":1,"repos":3,"skip_authors":2}
```
`freshlyCreated:true` on every boot is the unambiguous signal the mount isn't working.

## Known limits / non-goals

- **No webhooks.** Sub-minute latency is not a goal.
- **No retries/queue.** A transient GitHub error means the PR gets picked up on the next tick.
- **No auth on the UI.** Loopback-only by default; put it behind your VPN if exposed.
- **No Jira / Linear integration.** Deliberately gone.
- **Max plan only.** If your Max session expires, `claude -p` fails and the bot logs an error. It does not fall back to the API.
