# arbiter

Automated GitHub PR review on your own infrastructure, powered by Claude Code.

> **Status:** scaffold. The previous v1 is preserved on the `archive/v1` branch.

## What it does (planned)

- Sign in with GitHub (OAuth) → arbiter polls your accessible repos.
- Define **scope rules**: which repos / orgs / branches to review, at what scrutiny tier (`light` / `standard` / `strict`).
- For every matching PR (skipping your own and configured bots), arbiter runs `claude -p` against the diff using the scrutiny prompt and posts the review to the PR.
- A web UI shows the queue, run history, and scope configuration.

## Stack

- Bun + TypeScript, single process
- Hono HTTP framework
- Postgres (via `postgres` package, no ORM)
- `@octokit/rest` for GitHub
- `claude -p` shell-out for review (default — uses your Claude Code subscription) with `ANTHROPIC_API_KEY` fallback

See [`DESIGN.md`](./DESIGN.md) for the visual system.

## Run locally

Prereqs: [Bun](https://bun.sh), [Docker](https://www.docker.com), and a logged-in `claude` CLI on the host (run `claude login` once).

```sh
cp .env.example .env
# edit .env: set SESSION_SECRET (random hex), GITHUB_CLIENT_ID/SECRET
bun run setup          # wires up subscription credentials for your OS
docker compose up --build
```

App listens on `http://localhost:8787`. Health check at `/healthz`.

## Subscription mode in Docker

Default mode shells out to `claude -p` inside the container, which needs
your host's Claude Code credentials bind-mounted at `/root/.claude`. The
plumbing differs by host OS — `bun run setup` handles it, but here's what
it does and why:

| Host    | What's needed | Why |
|---------|---------------|-----|
| **Linux**   | Nothing — default mount works. | Creds live in `~/.claude/.credentials.json`; `$HOME` resolves. |
| **Windows** | `CLAUDE_HOST_DIR` in `.env` (setup sets it). | `$HOME` is unset under PowerShell, so the compose default falls back to a nonexistent `/root/.claude` and mounts **empty**. |
| **macOS**   | Export Keychain → `~/.claude/.credentials.json` (setup does it). | Claude Code stores creds in the Keychain, not a file, so the bind-mount has nothing to carry. |

Prereq for all: be logged in (`claude` once on the host).

**Fail-fast preflight.** On boot in subscription mode the app runs one
quick `claude -p` check (≤30s). If credentials aren't reachable it
exits immediately with OS-specific instructions in the logs
(`docker compose logs app`) instead of silently hanging 5 minutes per
review and reporting a misleading timeout.

**Caveats**

- **Shared queue / single worker.** All reviews share one DB queue drained
  by one worker. Whichever container's worker grabs a job uses *that*
  container's credentials and GitHub token. Running multiple containers
  against one DB means they compete on the same queue — fixing the mount
  doesn't change that.
- **macOS snapshot drift.** The exported file is a point-in-time copy. The
  container refreshes its own copy independently of the host Keychain. If
  container reviews start timing out weeks later, re-run `bun run setup`.
- **Escape hatch.** Set `CLAUDE_DEFAULT_MODE=api` + `ANTHROPIC_API_KEY` to
  skip all of this (no per-host login, no bind-mount), at the cost of
  per-token billing instead of the subscription.

## Layout

```
src/
  config.ts              env parsing
  db.ts                  postgres + migration runner
  github/
    oauth.ts             OAuth login flow (stub)
    api.ts               octokit wrapper
    poller.ts            periodic PR poller (stub)
  scope.ts               scope rule matching
  review/
    runner.ts            claude -p / API runner (stub)
    prompts/             scrutiny-tier prompt templates
  worker.ts              review queue worker (stub)
  web/
    server.ts            Hono app
  index.ts               boot
migrations/
  001_init.sql           initial schema
DESIGN.md                visual design system
docker-compose.yml       app + postgres
Dockerfile
```

## License

MIT (placeholder — no LICENSE file in scaffold yet).
