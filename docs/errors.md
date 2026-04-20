# review-me Error Taxonomy

Every failure in the review pipeline emits a structured `review.error` log line
with a stable `code` field. This lets operators build dashboards and oncall
runbooks without parsing free-form strings.

## Log line shape

```json
{
  "ts": "2026-04-20T12:00:00.000Z",
  "level": "error",
  "msg": "review.error",
  "evt": "review.error",
  "code": "GITHUB_DIFF_FETCH_FAILED",
  "stage": "diff-fetch",
  "retryable": true,
  "repo": "acme/widget",
  "pr": 42,
  "message": "failed to fetch PR diff"
}
```

Key fields:

| Field       | Type    | Description                                         |
|-------------|---------|-----------------------------------------------------|
| `evt`       | string  | Always `"review.error"` — use for log routing       |
| `code`      | string  | Stable enum value (see table below)                 |
| `stage`     | string  | Pipeline stage where the error occurred             |
| `retryable` | boolean | `true` if the operation is safe to retry            |
| `repo`      | string  | `owner/name` of the repo under review               |
| `pr`        | number  | Pull request number                                 |
| `message`   | string  | Human-readable description of the specific failure  |

## Error code reference

| Code | Stage | Retryable | Description |
|------|-------|-----------|-------------|
| `GITHUB_DIFF_FETCH_FAILED` | `diff-fetch` | yes | GitHub API returned a non-2xx status while fetching the PR diff or file list. Check `GITHUB_PAT` permissions (contents read, pull requests read). |
| `DIFF_TOO_LARGE` | `diff-fetch` | no | The PR diff exceeded the configured character budget (`DEFAULT_MAX_DIFF_CHARS`, default 150 kB). The bot fails open — it posts a human-review prompt instead of blocking the PR. This code is informational; no action required unless the threshold needs tuning. |
| `JIRA_TICKET_NOT_FOUND` | `intent-resolve` | no | Jira returned a 404 (or equivalent) for the ticket key extracted from the PR. The pipeline continues with the PR description as fallback intent; no action needed unless you want accurate intent-awareness for this PR. |
| `ANTHROPIC_RATE_LIMITED` | `llm-review` | yes | Anthropic responded with HTTP 429. The review did not complete. Retry after the rate-limit window resets. If this is frequent, consider raising the review concurrency delay or upgrading the Anthropic tier. |
| `ANTHROPIC_INVALID_TOOL_OUTPUT` | `llm-review` | no | Anthropic responded with HTTP 200 but `parsed_output` was `null` or failed schema validation. This indicates a model output format change or a prompt regression. File an issue with the raw Anthropic response if reproducible. |
| `POST_REVIEW_FORBIDDEN` | `post-review` | no | GitHub returned HTTP 403 when the bot tried to post the review. Verify that `GITHUB_PAT` has `pull_requests: write` permission on the target repo and that the machine-user account has been given write access as a collaborator. |

## Pipeline stages

| Stage | Description |
|-------|-------------|
| `diff-fetch` | Fetching the PR metadata and file diff via the GitHub REST API |
| `intent-resolve` | Extracting the Jira ticket key and fetching the ticket summary + description |
| `llm-review` | Sending the diff and intent to Claude and parsing the structured verdict |
| `post-review` | Creating the GitHub Review (approve or comment) via the Reviews API |

## Metrics (future)

The metric counter `reviewme_review_failures_total{stage,code}` consumes these
codes. Instrumentation is tracked in issue #2 (observability / metrics) and is
intentionally left out of this module to avoid coupling.
