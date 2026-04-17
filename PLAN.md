# reviewme — Implementation Plan

An intent-aware PR review bot that layers constructive, guidance-oriented feedback on top of CI. Approves clean PRs, leaves line-level comments with a summary when there are issues.

## Design (locked)

| Decision | Choice |
|---|---|
| Identity | Machine user account + PAT (reviews count toward branch protection) |
| Trigger | GitHub webhooks on allowlisted repos |
| Events | `pull_request` (opened/synchronize), `check_suite.completed` |
| CI gate | Skip review until CI green; no LLM tokens spent on red PRs |
| Intent source | Linked Jira ticket; fallback to PR description (log warning) |
| Review style | Intent-aware — does PR do what ticket claims; logic bugs; missing test coverage |
| Output | Line-level comments + summary comment; approve if clean |
| Tone | Constructive — "here's how to get there", not "try again" |
| Re-review | Per-repo config — `auto-on-sync` OR `label-or-mention` |
| Stack | Bun + TypeScript |
| Deploy | Self-hosted on internal VM / webhost behind existing HTTPS ingress |

## Out of scope (MVP)

- Teams / Slack integration (original idea; dropped — webhooks are better)
- Duplication/style checks (SonarQube already does this in CI)
- Multi-org installation flow
- Web dashboard / UI
- Historical review replay

## Architecture

```
GitHub --webhook--> /webhook endpoint (Bun HTTP)
                        |
                        v
                    Event router
                    /           \
     pull_request              check_suite.completed
     - record PR state          - lookup PR(s) for suite
     - wait for CI              - if green, trigger review
                                          |
                                          v
                                   Review pipeline:
                                   1. Fetch PR diff
                                   2. Fetch Jira ticket (or fallback)
                                   3. Fetch repo config
                                   4. LLM review (Anthropic SDK)
                                   5. Post line comments + summary
                                   6. Approve if clean
```

## Implementation phases

### Phase 1 — Scaffolding
- [ ] `bun init` in repo root; TypeScript, strict mode
- [ ] Deps: `@octokit/rest`, `@octokit/webhooks`, `@anthropic-ai/sdk`, `zod`
- [ ] `.env.example` with: `GITHUB_PAT`, `GITHUB_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `PORT`
- [ ] Basic project layout: `src/{server,github,jira,review,config}/`
- [ ] `bun test` setup with a couple smoke tests

### Phase 2 — Webhook service
- [ ] Bun HTTP server on `/webhook`
- [ ] HMAC signature verification (reject unsigned/invalid)
- [ ] Route `pull_request` and `check_suite.completed` to handlers; ignore others
- [ ] Structured logging (JSON) with request IDs

### Phase 3 — GitHub glue
- [ ] Octokit client bound to machine-user PAT
- [ ] Repo allowlist check (config-driven)
- [ ] `check_suite.completed` → resolve associated PRs → only proceed if `conclusion === 'success'` AND all required check runs passed
- [ ] Fetch PR diff (paginate if large; chunk if needed for LLM)

### Phase 4 — Jira + intent
- [ ] Parse PR title/branch/description for ticket key (configurable regex, default `[A-Z]+-\d+`)
- [ ] Fetch ticket via Jira REST API; extract summary + description + acceptance criteria
- [ ] Fallback path: use PR body only; flag in summary comment that intent was inferred

### Phase 5 — LLM review
- [ ] Anthropic SDK with prompt caching on the system prompt + repo conventions
- [ ] Structured output (tool use): `{ verdict: 'approve' | 'comment', summary: string, line_comments: [{path, line, body}] }`
- [ ] Focus categories: intent match, logic correctness, test coverage for new branches
- [ ] Token budget guardrail: fail-open with a warning comment if PR diff exceeds threshold

### Phase 6 — Posting reviews
- [ ] Create a GitHub Review via Reviews API with:
  - `event: 'APPROVE'` when verdict is `approve`
  - `event: 'COMMENT'` when verdict is `comment` (leaves inline + summary, does not block)
- [ ] Never post `REQUEST_CHANGES` — violates the "guide, don't block" principle
- [ ] Deduplicate: if a prior review from the bot exists on this head SHA, skip

### Phase 7 — Re-review triggers
- [ ] Per-repo config file (central, in this repo): `repos.yaml` with entries
  ```yaml
  - owner/name:
      enabled: true
      rereview: auto-on-sync  # or: label-or-mention
      rereview_label: "re-review"   # when mode is label-or-mention
  ```
- [ ] `pull_request.synchronize` event → honor mode
- [ ] `pull_request.labeled` and `issue_comment` (with `/reviewme`) for manual trigger

### Phase 8 — Deployment (self-hosted)
- [ ] Dockerfile (Bun base image) — runnable via `docker run` or `docker compose`
- [ ] Alternative: `systemd` unit file for bare-metal install (`bun run src/server/index.ts`)
- [ ] HTTPS terminated at existing reverse proxy (nginx/caddy/traefik); app binds HTTP on loopback or internal interface
- [ ] `/health` endpoint for proxy health checks; `/ready` for warmup
- [ ] Log to stdout (JSON); operator routes to journald / existing log pipeline
- [ ] Secrets via env file mounted by the host (no cloud secret manager dependency)
- [ ] GitHub webhook URL pointed at the public ingress path (e.g. `https://tools.example.com/reviewme/webhook`) — either per-repo or org-level webhook
- [ ] Document: required firewall rules (inbound 443 from GitHub IP ranges only), secret rotation procedure, restart/rollback runbook in README

## Open questions (to resolve during implementation, not blockers)

1. **Diff chunking strategy** when PR is huge — summarize file-by-file then synthesize? Or hard-cap with a "PR too large for automated review" comment?
2. **Repo conventions ingestion** — does the bot read `CLAUDE.md` / `CONTRIBUTING.md` / `.cursorrules` from the target repo to calibrate style? Nice-to-have.
3. **Cost observability** — log token usage per review; later, a weekly summary.
4. **Retry/backoff** when Jira or LLM fails — idempotency based on `(repo, PR, head SHA)`.

## Success criteria (MVP)

- Machine-user bot posts a review within ~60s of CI going green on an allowlisted repo
- At least 80% of clean PRs get an `APPROVE` with a useful summary
- Line comments are actually actionable (not "consider reviewing this function")
- Zero false-positive `APPROVE` on PRs that don't implement the ticket
