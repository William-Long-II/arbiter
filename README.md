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
docker compose up --build
```

App listens on `http://localhost:8787`. Health check at `/healthz`.

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
