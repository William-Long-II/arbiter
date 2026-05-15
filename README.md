# arbiter

Automated GitHub PR review on your own infrastructure, powered by Claude Code.

> **Status:** working. Single-process app; one DB-backed review queue drained
> by one worker. The previous v1 is preserved on the `archive/v1` branch.

## What it does

- Sign in with GitHub (OAuth) → arbiter polls your accessible repos.
- Define **scope rules**: which repos / orgs / branches to review, at what
  scrutiny tier (`light` / `standard` / `strict`), with optional per-scope
  trigger mode (`open` vs `review_requested`), review context
  (`isolated` vs `checkout`), auto-approve, footer, and personality prompt.
- For every matching PR (skipping your own, configured bots, drafts, and
  auto-merge PRs), arbiter waits out pending CI, runs `claude -p` against the
  diff with the scrutiny prompt, and posts the review back to the PR.
- A web UI shows the live queue (SSE, no polling), per-review detail with the
  rendered review + prior runs, scope configuration, and accessible repos.

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
- **First-run config notice.** The image seeds a minimal `/root/.claude.json`;
  if you ever see a `config file not found at /root/.claude.json` notice on
  stderr it's harmless and self-heals on the first `claude -p` call — it
  doesn't touch the JSON the runner parses on stdout.
- **Escape hatch.** Set `CLAUDE_DEFAULT_MODE=api` + `ANTHROPIC_API_KEY` to
  skip all of this (no per-host login, no bind-mount), at the cost of
  per-token billing instead of the subscription.

## Layout

```
src/
  config.ts              env parsing
  db.ts                  postgres pool + migration runner + LISTEN bus
  errors.ts              thrown-value → useful string
  events.ts              in-process pub/sub (SSE fan-out)
  retention.ts           hourly prune: old reviews + expired sessions
  scope.ts               scope rule matching (glob branch patterns)
  worker.ts              review queue worker (claim → review → post)
  index.ts               boot (preflight, migrate, serve, schedules)
  github/
    api.ts               octokit factory
    oauth.ts             GitHub OAuth login flow
    poller.ts            periodic PR poller (GraphQL search)
    pulls.ts             PR fetch + large-diff reconstruction
    repos.ts             accessible-repo listing + cache
    checks.ts            CI/checks summary
  review/
    runner.ts            claude -p / Anthropic API runner
    format.ts            pure prompt/parse helpers
    footer.ts            review footer templating
    prompts/             scrutiny-tier prompt templates
  db/
    users.ts             users + sessions
    scopes.ts            scope CRUD + form parsing
    reviews.ts           queue: enqueue/claim/defer/retry, overrides
  web/
    server.tsx           Hono app + routes
    auth.ts              session middleware
    cookies.ts           HMAC-signed cookies
    views/               server-rendered JSX pages
migrations/              001..010 — incremental schema
DESIGN.md                visual design system
docker-compose.yml       app + postgres
Dockerfile
```

## License

MIT (placeholder — no LICENSE file yet).
