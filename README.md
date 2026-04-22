# Auto-Reviewer for PRs

A small, locally-dockerized service that polls GitHub for pull requests you did not author, waits until CI is green, and posts a per-line code review using your existing Claude **Max** plan via `claude -p`. No Anthropic API billing. No webhooks. No public endpoint needed.

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
- **Dry-run by default.** First boot logs what it *would* have posted. Flip `review.dry_run: false` when you trust it.
- **Idempotent.** SQLite tracks `(repo, pr_number, head_sha)`. A new push re-triggers review; an unchanged push doesn't.

## Prerequisites

- Docker + Docker Compose
- A Claude Max subscription logged in on the host (`claude /login` — the session file goes to `~/.claude`)
- A GitHub personal access token for the **bot account** (not your personal account). Scopes: `repo` read, `pull_request` write. The bot user is who the review appears from, and is what satisfies branch-protection approvals.

## Setup

```bash
cp .env.example .env             # set GITHUB_TOKEN
cp config.example.yaml config.yaml  # set bot_username, skip_authors, watch
docker compose up -d --build
docker compose logs -f auto-reviewer
```

## Configuration

`config.yaml` supports mixed org- and repo-level watches so you can say "all of org A, only two repos from org B, and this one personal repo":

```yaml
github:
  bot_username: my-review-bot
  skip_authors: [my-github-login]   # PRs from these authors are ignored

watch:
  orgs:
    - name: org-a
      mode: all
      # exclude: [archived-thing]
    - name: org-b
      mode: include
      include: [shared-lib, deploy-scripts]
  repos:
    - my-github-login/side-project

review:
  dry_run: true                       # start here; flip when you trust it
  max_approvals_per_hour: 10          # safety cap
  skip_drafts: true
  require_ci_green: true
  tone: |
    Be constructive and specific. For every issue, explain WHY it matters
    and HOW to fix it. Skip trivial nits.

poll:
  interval_seconds: 60

claude:
  command: claude
  timeout_seconds: 600
```

## Safety rails

- **Dry run is the default.** Nothing posts until you turn it off.
- **Approval rate limit.** `max_approvals_per_hour` caps how many approving reviews the bot can post in a rolling hour.
- **CI gate.** `require_ci_green` (default `true`) skips PRs whose non-approval checks are pending or failing.
- **Self-skip.** Your own PRs (the user listed in `skip_authors`) are ignored. The bot never reviews itself either.
- **Drafts.** Skipped by default.

## Development

```bash
bun install
bun test            # unit tests (diff hunk parser, JSON extractor, review validator)
bun run typecheck
bun run start       # runs the loop locally; needs GITHUB_TOKEN + config.yaml
```

## Layout

```
src/
  config.ts              zod-validated YAML loader
  log.ts                 JSON log lines
  github/
    client.ts            Octokit factory
    discover.ts          org→repo resolution, PR listing, author filter
    ci.ts                combined check-runs + commit-status evaluation
    diff.ts              PR files + hunk parser (validates comment lines)
  claude/
    prompt.ts            prompt template
    schema.ts            zod schema for the review JSON
    invoke.ts            Bun.spawn of `claude -p`, extracts JSON, validates
  review/
    validate.ts          drops comments outside hunks, folds into summary
    post.ts              posts review via Octokit (APPROVE / REQUEST_CHANGES)
  state/
    db.ts                sqlite: reviewed-SHA dedupe + approval rate counter
  loop.ts                one tick: discover → CI → claude → validate → post
  index.ts               startup, config load, tick loop, SIGINT/SIGTERM

tests/                   bun:test
```

## Known limits / non-goals

- **No webhooks.** If you need sub-minute latency, this is not for you.
- **No retries/queue.** A transient GitHub error means the PR gets picked up on the next tick; that's the whole retry strategy.
- **No Jira / Linear integration.** The previous version had this; the rewrite deliberately does not.
- **Max plan only.** If your Max session expires, `claude -p` fails and the bot logs an error. It does not fall back to the API.
