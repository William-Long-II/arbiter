---
stepsCompleted: [1, 2, 3, 4]
inputDocuments: []
session_topic: 'Arbiter codebase cleanliness review + new feature ideation'
session_goals: 'Phase A — audit the app for cleanliness/quality issues and surface a concrete findings list. Phase B — diverge on a large set of new feature ideas, then converge on a prioritized shortlist.'
selected_approach: 'progressive-flow'
techniques_used: ['full-codebase-audit', 'domain-rotated-divergence', 'impact-effort-leverage-convergence']
ideas_generated: 58
constraint: 'heading to team/org scale'
context_file: ''
---

# Brainstorming Session Results

**Facilitator:** Will
**Date:** 2026-05-15

## Session Overview

**Topic:** Arbiter codebase cleanliness review + new feature ideation

**Goals:**
- **Phase A — Cleanliness review:** in-depth pass over the app to confirm it's clean (architecture smells, dead/stale code, doc drift, test coverage, error handling), producing a concrete, prioritized findings list.
- **Phase B — Feature ideation:** divergent brainstorm of new features arbiter should implement, then converge on a prioritized shortlist.

### Context Guidance

Arbiter is a Bun + TypeScript single-process app: automated GitHub PR review on the user's own infra, powered by `claude -p`. Hono HTTP, Postgres (no ORM), Octokit, JSX server-rendered web UI. ~6,400 LOC across `src/`, 20 test files, 10 migrations, 213+ PRs merged. README still describes it as a "scaffold" with stubs — **stale**; the app is actually a working tool.

### Session Setup

**Decisions:**
- **Sequence:** Phase A (full audit) → triage → Phase B (feature brainstorm).
- **Audit depth:** Full — typecheck + test suite, read every src module, smells/dead code/doc drift/error handling/security/coverage. Prioritized findings with severities.
- **Phase B focus areas (all selected):** Reviewer intelligence · Workflow & integrations · Operability & scale · UX & product surface.

## Phase A — Cleanliness Audit

**Method:** `tsc --noEmit` (clean, exit 0, strict mode) · `bun test` (171 pass / 0 fail / 20 files) · full read-through of all 31 `src` modules + Dockerfile/compose/migrations/prompts.

**Verdict:** This is a genuinely well-maintained codebase, not a messy one. One real security issue, a few small hygiene/coverage items. Quality is high: strict TS, "why"-comments, idempotent queue, safe concurrency primitive, careful secret handling.

### Findings (prioritized)

| # | Sev | Finding | Location | Fix |
|---|-----|---------|----------|-----|
| 1 | **High** | **Stored XSS**: review body rendered via `marked.parse()` → `dangerouslySetInnerHTML` with no sanitizer. The in-code rationale ("same trust boundary as the GitHub PR comment") is wrong — GitHub *sanitizes* comment markdown; arbiter does not. Review bodies are model output derived from **untrusted third-party PR diffs** (reviewing others' PRs is the tool's purpose). An adversarial PR can attempt to reflect HTML/JS into the body; it then executes in the operator's authenticated arbiter session and can drive same-origin state changes (scopes, approvals — CSRF guard is same-origin, which XSS satisfies). | `src/web/views/queue-detail.tsx:18-22,281` | Sanitize (DOMPurify / marked sanitizer) or sandboxed iframe. ~½ day |
| 2 | Med | `pruneExpiredSessions()` defined but **never called** anywhere; `retention.ts` only prunes `pending_reviews`. `sessions` table grows unbounded; expired rows live forever. | `src/db/users.ts:82`, `src/retention.ts` | Wire into retention loop. Tiny |
| 3 | Med | DB/queue-concurrency layer **appears untested** — suite runs green with no Postgres, so `claimNext` (`FOR UPDATE SKIP LOCKED`), enqueue idempotency, defer/retry gating (the most concurrency-critical code) is not exercised. | `tests/`, `src/db/reviews.ts` | Add PG-backed integration tier in CI. Med |
| 4 | Med | `/api/debug/enqueue-review` + `/api/debug/run-review` ship in **production**; `run-review` burns a real Claude call (cost), auth-gated but no rate limit / no env gate. | `src/web/server.tsx:585,649` | Gate behind flag or non-prod. Small |
| 5 | Low | **README stale**: says "scaffold"/"stub"; app is a working ~6.4k-LOC tool, 10 migrations, 213 PRs. Misleads contributors. | `README.md` | Rewrite status + layout |
| 6 | Low | Stale "stub" header comment + **dead `PRMeta` type** (unused; real type is `PRDetails`). | `src/github/api.ts:1,9` | Delete |
| 7 | Low | Stale type-escape: `(config as unknown as Record<string,unknown>).reviewRetentionDays` with a comment claiming `Config` doesn't declare it — but `config.ts:47` now does. | `src/web/server.tsx:351` | Use the typed field |
| 8 | Low | `web/server.tsx` = 964 LOC: routing + CSRF + form parsing + 125-line inline landing-page HTML string in one file. | `src/web/server.tsx` | Split routes by resource; move `landingPage()` to a view |
| 9 | Low | Branch glob is prefix-only (`release/*` ok; `*/hotfix`, `feat/*/wip` not). Documented as "simple glob". | `src/scope.ts:28` | Known limitation → candidate feature |

### Positives (stated honestly)
- Typecheck clean (strict), 171 tests green.
- Defensive error handling: `describeError`, locked-conversation skip-with-body-preserve, diff-too-large reconstruction, watchdog + boot preflight.
- Idempotent queue (`ON CONFLICT`), safe claim (`FOR UPDATE SKIP LOCKED`), token passed via `http.extraheader` (never in `.git/config`/reflog), temp checkout dir always cleaned, `NODE_ENV=production` set in Dockerfile so cookies are `Secure`.
- Consistent intent-explaining comments; clean module boundaries; pure/impure split for unit-testability.

### Triage outcome — all 9 fixed (branch `fix/audit-cleanup`)

| # | Fix shipped |
|---|-------------|
| 1 | `renderReviewMarkdown()` in `queue-detail.tsx` — `marked` output now run through `sanitize-html` (GFM allowlist, scheme allowlist, `rel`/`target` on links); misleading rationale comment replaced. |
| 2 | `retention.ts` split into `pruneReviews()` (respects `REVIEW_RETENTION_DAYS`) + `pruneSessions()` (always runs); `pruneExpiredSessions()` now wired in. |
| 3 | `tests/queue-integration.test.ts` — Postgres-backed coverage of enqueue idempotency / `claimNext` exclusivity / retry gating / defer; `describe.skip` + warning when no DB (suite stays green). |
| 4 | `config.enableDebugEndpoints` (`ENABLE_DEBUG_ENDPOINTS`, default off); both `/api/debug/*` routes 404 unless enabled; `.env.example` documented. |
| 5 | README rewritten — "working" status, accurate module tree, no "stub/scaffold". |
| 6 | Dead `PRMeta` type + "stub" comment removed from `github/api.ts`. |
| 7 | `server.tsx:351` `as unknown` cast replaced with typed `config.reviewRetentionDays`. |
| 8 | `landingPage()` extracted to `src/web/views/landing.ts`; `server.tsx` −143 lines. |
| 9 | `scope.ts matchBranch` upgraded to a full glob (`*`/`?` anywhere, regex-meta safe); +5 tests. |

**Verification:** `tsc --noEmit` clean · `bun test` → 175 pass / 0 fail / 6 skip (integration suite, no local DB). Not committed/pushed yet — awaiting your call.

---

## Phase B — Feature Ideation (progressive flow)

_Divergent generation across the four chosen areas + orthogonal categories, grounded in the audited codebase. Goal: breadth first, resist the obvious, converge later._

### Wave 1 — Divergent set (~58 ideas, domain-rotated)

**Reviewer intelligence**
1. **Calibration loop** — synthesize accepted/overridden findings from the existing `review_overrides` table (captured today, consumed by nothing) into a per-scope auto-tuned preamble.
2. Repo-aware context pack — cache `CLAUDE.md`/`CONTRIBUTING`/lint+manifest from head and inject (a tier between `isolated` and `checkout`).
3. Sensitive-path scrutiny escalation — auto-bump tier when diff touches auth/migrations/crypto/CI/Dockerfile.
4. Two-pass review — cheap Haiku triage → escalate Opus-strict only on flagged hunks (depth where it matters, cost control).
5. Inline line comments — anchor findings to diff lines via `pulls.createReview comments[]` (today: one blob).
6. Severity JSON schema — model emits blocking/major/minor/nit → parsed to DB → filter, metrics, gating.
7. ` ```suggestion ` blocks — one-click-applyable fixes for trivial nits.
8. Re-review delta mode — on new head SHA, review only the incremental diff vs. prior review.
9. Test-gap signal — flag `src/**` changes with no `tests/**` change.
10. Language/framework prompt packs — auto-detected by file extensions.

**Operability & scale**
11. Multi-worker (queue already uses `FOR UPDATE SKIP LOCKED` — concurrency primitive is done).
12. **Per-job token binding** — job carries its owning user's creds regardless of container; fixes the documented shared-queue token-bleed caveat and unblocks #11/#19.
13. `/metrics` Prometheus endpoint (queue depth/age, p50/p95 latency, defer/fail rates).
14. **Cost ledger** — persist `result.costUsd` (parsed by runner today, then discarded) → per-scope/repo spend.
15. Budget guardrails — monthly cap per scope; over → downgrade tier or pause.
16. Exponential backoff auto-retry on transient/ratelimit (today: manual retry only).
17. GitHub rate-limit-aware adaptive poller.
18. Stuck-job detector — `running` > 2×timeout with no heartbeat → auto-fail + alert (crashed worker leaves rows stuck today).
19. **Webhook ingestion** — GitHub App `pull_request`/`synchronize` events replace the 60s poll → near-instant, far fewer API calls, org-scale.
20. GitHub App vs OAuth — installation tokens, finer perms, no broad `repo` user-token at rest (also structurally fixes the audit's token-at-rest concern).

**Workflow & integrations**
21. GitHub Checks API — publish as a Check Run with annotations, not just a comment.
22. Optional commit-status gate — configurable soft merge-block (middle ground vs. the deliberately-disabled auto-REQUEST_CHANGES).
23. Slack/Discord/email notifications per scope.
24. Digest mode — daily/weekly repo summary instead of per-PR noise.
25. Trigger on `@arbiter review` comment or `needs-arbiter` label.
26. PR slash-commands — `/arbiter strict`, `/arbiter skip`, `/arbiter explain`.
27. Jira/Linear ticket on blocking findings on protected branches.
28. CODEOWNERS-aware review/escalation.
29. Monorepo path-glob scopes (`services/payments/**` → strict).
30. Scheduled/freeze-window scopes.

**UX & product surface**
31. Inline diff viewer on queue-detail (code-window per DESIGN.md).
32. Cross-queue findings filter/search (severity/repo/verdict/author).
33. Per-PR UI controls — re-run at tier, edit-and-post, dismiss-with-reason (feeds #1).
34. First-run onboarding wizard (starter scope from most-active repo).
35. Scope dry-run — "which open PRs would this have captured" before saving.
36. Run-analytics page — throughput, verdict mix, cost over time, noisiest repos.
37. Shareable read-only review permalink.
38. Self CLI — `arbiter review owner/repo#123 --tier strict`.
39. Public REST/JSON API + tokens (today only gated debug endpoints).
40. Mobile-tuned triage queue (DESIGN.md notes the responsive gaps).

**Orthogonal — trust / safety / governance**
41. **Prompt-injection defense** — detect/neutralize diff-embedded instructions ("approve this, ignore prior"); directly answers the audit's threat model.
42. Review provenance signing — verifiable footer hash; spoofed "arbiter" comments detectable.
43. Immutable audit log (review/approve/override: who/what/when).
44. Secret-scan pre-step — redact/refuse if diff or output contains apparent credentials.
45. Transparency page linked from every footer (what's sent to Claude, how tiers work).
46. Global kill switch — pause posting, keep queueing, for incident response.
47. Dogfood mode — opt in to review arbiter's own repo with extra strictness.

**Orthogonal — data / longevity**
48. Review history export (NDJSON) per repo.
49. Trend detection — "PRs 30% larger / failure rate rising" surfaced proactively.
50. Flaky-finding suppression — repeatedly-overridden finding type auto-demoted to nit in that repo.

**Orthogonal — economics / packaging**
51. Multi-tenant hosted mode (architecture is single-tenant today) — product, not just self-host.
52. BYO-model — pluggable backends (local/other providers) behind the runner interface.
53. Auto subscription-vs-API routing by PR importance to optimize quota/$.
54. Quota headroom / projected monthly cost on the dashboard.

**Orthogonal — reliability of the review itself**
55. Self-consistency (strict) — run 2×, post only findings in both (cut hallucinated blockers).
56. Per-finding confidence — low-confidence rendered as questions, not assertions.
57. Checkout hallucination guard — verify cited files/symbols exist before posting.
58. Diff-grounding assertion — regenerate if review cites lines/files absent from the diff.

### Wave 2 — Convergence: prioritized roadmap (lens: heading to team/org scale)

**Accuracy note:** the GitHub token is *already* per-job (`worker.ts` → `loadUser(job.userId)`). The real multi-container blocker is (a) subscription `claude -p` creds are container-global and (b) one shared queue with one worker. So the scale foundation = webhooks + in-process worker pool + an explicit "API-mode for multi-container" stance — not a token-binding fix.

Scoring: Impact (org-scale) · Effort (S/M/L) · Leverage (unlocks other items).

---

#### Track 0 — Quick wins (do first; days, high ratio)
| Idea | Why now (org-scale) | Effort |
|------|--------------------|--------|
| **#14 Cost ledger** | `runner` already parses `total_cost_usd` then discards it. At org volume, spend blindness is the #1 risk. Migration + persist + a dashboard number. Unlocks #15, #54. | S |
| **#18 Stuck-job detector** | A crashed worker silently wedges the shared queue — fatal at scale. Auto-fail `running` > 2×timeout. | S |
| **#16 Backoff auto-retry** | Manual-retry-only doesn't survive volume; transient/ratelimit failures should self-heal. | S–M |
| **#3 Sensitive-path escalation** | Cheap, high-value review-quality win independent of everything else. | S |
| **#9 Test-gap signal** | One heuristic, meaningful signal. | S |

#### Track 1 — Scale foundation (the unlock; highest org-scale priority)
| Idea | Why | Effort |
|------|-----|--------|
| **#19 Webhooks (GitHub App)** | Kills poll fan-out + double-poll; near-instant reviews; org-scale API economy. Also delivers **#20** (App installation tokens → no broad `repo` user token at rest, closes the audit's top security concern). The keystone. | L |
| **#11 Multi-worker pool** | In-process N workers; `FOR UPDATE SKIP LOCKED` already makes this safe. Single-container path needs no cred change. | M |
| **#13 `/metrics` endpoint** | Operating at org scale blind is untenable; queue depth/age/latency/fail-rate. | M |
| Multi-container stance | Document/enforce: multi-container ⇒ API mode (no bind-mount); subscription mode = single container. Removes the caveat by making it a supported choice. | S |

#### Track 2 — Actionability (review value compounds with volume)
| Idea | Why | Effort |
|------|-----|--------|
| **#6 Severity JSON schema** | Foundational — unlocks #21/#22 gating, #32 filtering, #50. Do before the others. | M |
| **#5 Inline line comments** | Biggest single actionability jump vs. one comment blob. | M |
| **#21 Checks API + #22 status gate** | Proper pass/neutral gate; configurable soft merge-block. Depends on #6. | M |
| **#8 Re-review delta mode** | At volume, re-reviewing whole PRs every push wastes $ and adds noise. | M |

#### Track 3 — Trust / safety (required as more teams/repos are exposed)
| Idea | Why | Effort |
|------|-----|--------|
| **#41 Prompt-injection defense** | The audit's threat model, productized. | M |
| **#43 Audit log + #42 provenance signing** | Org/compliance + spoof-resistant reviews. | M |
| **#1 Calibration loop** | Uses the unused `review_overrides` data (pair with **#33** dismiss-with-reason UI). Long-term differentiator. | M–L |

#### Track 4 — Big bets / later
#51 multi-tenant · #23/#24 notifications + digest · #36 analytics · #29 monorepo path scopes · #25/#26 comment/label triggers · #52 BYO-model.

---

### Recommended sequence
1. **Track 0** (1 short iteration — momentum + closes operational risk before scaling).
2. **#19 webhooks/GitHub App** (the keystone — everything org-scale rides on it; also retires the token-at-rest finding).
3. **#6 → #5 → #21/#22** (actionability spine, in that order).
4. **#11 + #13** (scale out once the work is worth scaling).
5. **Track 3** as exposure widens; **Track 4** opportunistically.

**Dependency edges:** #14→#15,#54 · #6→#21,#22,#32,#50 · #19→#20 · #1↔#33 · #11 needs the multi-container stance decided.

---

### Execution log (2026-05-15)

| PR | Item | Branch | State |
|----|------|--------|-------|
| [#214](https://github.com/William-Long-II/arbiter/pull/214) | Audit: XSS + 8 hygiene/coverage fixes | `fix/audit-cleanup` | open |
| [#215](https://github.com/William-Long-II/arbiter/pull/215) | **#14 Cost ledger** | `feat/cost-ledger` | open |
| [#216](https://github.com/William-Long-II/arbiter/pull/216) | **#18 Stuck-job detector** | `feat/stuck-job-detector` | open |

**Merge-order note (historical):** #214/#215/#216 branched off `main` independently; resolved by merging in order. All later branches were cut off freshly-merged `main`.

### Execution log — continued

| PR | Item | State |
|----|------|-------|
| [#217](https://github.com/William-Long-II/arbiter/pull/217) | #3 sensitive-path escalation + #9 test-gap | merged |
| [#218](https://github.com/William-Long-II/arbiter/pull/218) | Octokit client reuse (user request: HTTP/connection perf) | merged |
| [#219](https://github.com/William-Long-II/arbiter/pull/219) | **#16 backoff auto-retry** | open |

**✅ Track 0 COMPLETE:** #14 cost ledger · #18 stuck-job detector · #3 sensitive-path · #9 test-gap · #16 backoff retry. Plus an out-of-band perf fix (#218 Octokit reuse) from the HTTP question.

**Keystone (#19) — decision:** "webhooks first on existing OAuth" (defer the full App migration). Slice 1 shipped:

| PR | Item | State |
|----|------|-------|
| [#219](https://github.com/William-Long-II/arbiter/pull/219) | #16 backoff auto-retry (Track 0 final) | open→merged |
| [#220](https://github.com/William-Long-II/arbiter/pull/220) | **#19 webhook receiver** (poller stays as safety net) | open |

**#19 status:** ✅ webhook ingestion on OAuth (signature-verified receiver, shared poller/webhook enqueue path). **Deferred:** auto-provisioning webhooks per scope; the full GitHub App migration (auth model + #20 token-at-rest retirement) — separate larger efforts.

**Roadmap position:** Track 0 done; keystone slice 1 done.

### Actionability spine

| PR | Item | State |
|----|------|-------|
| [#221](https://github.com/William-Long-II/arbiter/pull/221) | **#6 severity findings schema** | open |

| [#222](https://github.com/William-Long-II/arbiter/pull/222) | **#5 inline line comments** | open |

✅ #6 + #5 done — severity findings persisted/surfaced; inline PR comments (diff-validated, augmentative, body-only fallback). Next in spine: **#21/#22 Checks/status gate** keyed on `topSeverity` — a behavior-affecting, outward-facing change (can gate merges), so it warrants a product-decision checkpoint, not an auto-build.

### Full session PR ledger (214–224)
Audit #214 · cost #215 · stuck-job #216 · signals #217 · octokit-reuse #218 · backoff #219 · webhooks #220 · severity #221 · inline-comments #222 · blocking-gate #223 · /metrics #224.

**✅ Completed this session:** Track 0 (all) · keystone slice 1 (webhooks on OAuth) · **actionability spine in full (#6 severity → #5 inline comments → #21/#22 gate)** · one out-of-band perf fix (#218).

**Remaining big rocks (all design-checkpoint scale):** full GitHub App migration (#19/#20 rest — auth model, retires token-at-rest finding) · Track 1 (#11 multi-worker, #13 /metrics) · webhook auto-provisioning · Track 3 trust/safety (#41 prompt-injection defense, #43 audit log) · Track 4 big bets. Natural milestone reached — these warrant fresh sessions / explicit direction, not auto-continuation.
