import { Webhooks } from "@octokit/webhooks";
import type Anthropic from "@anthropic-ai/sdk";
import type { RepoAllowlist, ResolvedRepoConfig } from "../config";
import {
  evaluateHeadSha,
  fetchPullRequestDiff,
  hasAnyPriorReview,
  hasExistingReview,
  postReview,
  pullRequestHasLabel,
  removeLabelIfPresent,
  type Octokit,
} from "../github";
import { resolveIntent, type JiraCredentials } from "../jira";
import { runReview, DEFAULT_MODEL } from "../review";
import {
  isReviewError,
  logReviewError,
  wrapDiffFetchError,
  wrapIntentResolveError,
  wrapLlmReviewError,
  wrapPostReviewError,
} from "../review/errors";
import { recordUsage } from "../review/usage";
import { log } from "./logger";
import {
  incAnthropicTokens,
  incDraftSkipped,
  incReviewFailures,
  incReviewsTotal,
  incSlashCommand,
  incThreadReply,
  observeReviewDuration,
} from "./metrics";
import { enqueueOrThrow } from "./queue";
import { decideFromCheckSuite, parseSlashCommand } from "./triggers";
import { skipKey, skipRegistry } from "./skip-registry";
import { handleReviewCommentCreated } from "./handlers/review-comment";

export type WebhookDeps = {
  /**
   * Getter returning the current allowlist snapshot.
   *
   * Called at the start of each event handler so that new events pick up any
   * allowlist reloaded via SIGHUP. In-flight events that already captured a
   * snapshot reference before a reload are unaffected.
   */
  getAllowlist: () => RepoAllowlist;
  octokit: Octokit;
  anthropic: Anthropic;
  selfLogin: string;
  jiraCreds?: JiraCredentials;
};

type PrRef = {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
};

type TriggerSource = "check-suite" | "label" | "mention" | "ready-for-review";

type PipelineDeps = {
  octokit: Octokit;
  anthropic: Anthropic;
  selfLogin: string;
  jiraCreds?: JiraCredentials;
  deliveryId: string;
  source: TriggerSource;
  /** Fully-merged per-repo config (repo > org > built-in defaults). */
  entry: ResolvedRepoConfig;
};

export function createWebhooks(secret: string, deps: WebhookDeps): Webhooks {
  const webhooks = new Webhooks({ secret });
  const { getAllowlist, octokit, anthropic, selfLogin, jiraCreds } = deps;

  webhooks.on("pull_request.opened", async ({ id, payload }) => {
    const repo = payload.repository.full_name;
    const allowlist = getAllowlist();
    if (!allowlist.isAllowed(repo)) {
      log.debug("skip: repo not allowlisted", { deliveryId: id, repo });
      return;
    }
    if (payload.pull_request.draft === true) {
      log.info("skip.draft", {
        evt: "skip.draft",
        deliveryId: id,
        repo,
        pr: payload.pull_request.number,
        headSha: payload.pull_request.head.sha,
      });
      incDraftSkipped();
      return;
    }
    log.info("pull_request.opened", {
      deliveryId: id,
      repo,
      pr: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
    });
  });

  webhooks.on("pull_request.synchronize", async ({ id, payload }) => {
    const repo = payload.repository.full_name;
    const allowlist = getAllowlist();
    if (!allowlist.isAllowed(repo)) return;
    if (payload.pull_request.draft === true) {
      log.info("skip.draft", {
        evt: "skip.draft",
        deliveryId: id,
        repo,
        pr: payload.pull_request.number,
        headSha: payload.pull_request.head.sha,
      });
      incDraftSkipped();
      return;
    }
    log.info("pull_request.synchronize", {
      deliveryId: id,
      repo,
      pr: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
    });
    // Re-review decision happens in check_suite.completed.
  });

  webhooks.on("pull_request.reopened", async ({ id, payload }) => {
    const repo = payload.repository.full_name;
    const allowlist = getAllowlist();
    if (!allowlist.isAllowed(repo)) return;
    if (payload.pull_request.draft === true) {
      log.info("skip.draft", {
        evt: "skip.draft",
        deliveryId: id,
        repo,
        pr: payload.pull_request.number,
        headSha: payload.pull_request.head.sha,
      });
      incDraftSkipped();
      return;
    }
    log.info("pull_request.reopened", {
      deliveryId: id,
      repo,
      pr: payload.pull_request.number,
    });
  });

  webhooks.on("pull_request.ready_for_review", async ({ id, payload }) => {
    const repoFull = payload.repository.full_name;
    const entry = getAllowlist().getEffectiveConfig(repoFull);
    if (!entry?.enabled) {
      log.debug("skip: repo not allowlisted", { deliveryId: id, repo: repoFull });
      return;
    }

    const [owner, name] = repoFull.split("/");
    if (!owner || !name) return;

    const ref: PrRef = {
      owner,
      repo: name,
      pullNumber: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
    };

    log.info("pull_request.ready_for_review", {
      deliveryId: id,
      repo: repoFull,
      pr: ref.pullNumber,
      headSha: ref.headSha,
    });

    await triggerExplicit(ref, repoFull, {
      octokit,
      anthropic,
      selfLogin,
      jiraCreds,
      deliveryId: id,
      source: "ready-for-review",
      entry,
    });
  });

  webhooks.on("check_suite.completed", async ({ id, payload }) => {
    const repoFull = payload.repository.full_name;
    const entry = getAllowlist().getEffectiveConfig(repoFull);
    if (!entry?.enabled) {
      log.debug("skip: repo not allowlisted", { deliveryId: id, repo: repoFull });
      return;
    }

    const [owner, name] = repoFull.split("/");
    if (!owner || !name) return;

    const headSha = payload.check_suite.head_sha;
    const prs = payload.check_suite.pull_requests;
    if (prs.length === 0) return;

    const gate = await evaluateHeadSha(octokit, owner, name, headSha);
    log.info("check_suite.completed", {
      deliveryId: id,
      repo: repoFull,
      conclusion: payload.check_suite.conclusion,
      headSha,
      prCount: prs.length,
      gateGreen: gate.green,
    });

    if (!gate.green) {
      log.info("skip review: CI not green", {
        deliveryId: id,
        repo: repoFull,
        headSha,
        failingChecks: gate.green ? [] : gate.failingChecks,
      });
      return;
    }

    for (const pr of prs) {
      const ref: PrRef = {
        owner,
        repo: name,
        pullNumber: pr.number,
        headSha,
      };
      try {
        const hasPrior = await hasAnyPriorReview(
          octokit,
          ref.owner,
          ref.repo,
          ref.pullNumber,
          selfLogin,
        );
        const hasLabel =
          entry.rereview === "label-or-mention"
            ? await pullRequestHasLabel(
                octokit,
                ref.owner,
                ref.repo,
                ref.pullNumber,
                entry.rereview_label,
              )
            : false;
        const decision = decideFromCheckSuite(
          entry.rereview,
          hasPrior,
          hasLabel,
        );
        if (!decision.proceed) {
          log.info("skip review: mode gate", {
            deliveryId: id,
            repo: repoFull,
            pr: ref.pullNumber,
            headSha,
            reason: decision.reason,
          });
          continue;
        }

        enqueueOrThrow(
          () =>
            runPipeline(ref, {
              octokit,
              anthropic,
              selfLogin,
              jiraCreds,
              deliveryId: id,
              source: "check-suite",
              entry,
            }),
          { deliveryId: id, repo: repoFull, pr: ref.pullNumber },
        );

        // If a label triggered the gate, clear it so subsequent pushes need
        // re-confirmation. Mentions don't need clearing.
        if (entry.rereview === "label-or-mention" && hasLabel) {
          await removeLabelIfPresent(
            octokit,
            ref.owner,
            ref.repo,
            ref.pullNumber,
            entry.rereview_label,
          );
        }
      } catch (err) {
        // ReviewErrors are already logged inside runPipeline with the structured
        // `review.error` event. Only log the outer context for non-ReviewErrors
        // (e.g. mode-gate checks, label removal) or for unexpected errors that
        // slipped through without wrapping.
        if (!isReviewError(err)) {
          log.error("review pipeline failed", {
            deliveryId: id,
            repo: repoFull,
            pr: ref.pullNumber,
            headSha,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  });

  webhooks.on("pull_request.labeled", async ({ id, payload }) => {
    const repoFull = payload.repository.full_name;
    const entry = getAllowlist().getEffectiveConfig(repoFull);
    if (!entry?.enabled) return;
    if (entry.rereview !== "label-or-mention") return;
    if (payload.label?.name !== entry.rereview_label) return;

    const [owner, name] = repoFull.split("/");
    if (!owner || !name) return;

    const ref: PrRef = {
      owner,
      repo: name,
      pullNumber: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
    };

    log.info("pull_request.labeled triggered review", {
      deliveryId: id,
      repo: repoFull,
      pr: ref.pullNumber,
      label: payload.label.name,
    });

    await triggerExplicit(ref, repoFull, {
      octokit,
      anthropic,
      selfLogin,
      jiraCreds,
      deliveryId: id,
      source: "label",
      entry,
    });

    await removeLabelIfPresent(
      octokit,
      ref.owner,
      ref.repo,
      ref.pullNumber,
      entry.rereview_label,
    );
  });

  webhooks.on("issue_comment.created", async ({ id, payload }) => {
    // issue_comment fires on both issues and PR conversations. We only care
    // about PR comments.
    if (!payload.issue.pull_request) return;

    const repoFull = payload.repository.full_name;
    const entry = getAllowlist().getEffectiveConfig(repoFull);
    if (!entry?.enabled) return;

    const parsed = parseSlashCommand(payload.comment.body);
    if (!parsed) return;

    // Don't react to the bot's own comments (e.g. ack messages that happen to
    // contain a /review-me reference).
    if (payload.comment.user?.login === selfLogin) return;

    const [owner, name] = repoFull.split("/");
    if (!owner || !name) return;

    const prNumber = payload.issue.number;
    const commenter = payload.comment.user?.login ?? "(unknown)";
    const key = skipKey(repoFull, prNumber);

    log.info("slash command received", {
      deliveryId: id,
      repo: repoFull,
      pr: prNumber,
      commenter,
      command: parsed.command,
      raw: parsed.raw,
    });

    incSlashCommand(parsed.command);

    // Help and ack-only commands don't need the head SHA; only re-review does.
    switch (parsed.command) {
      case "help": {
        const helpBody = [
          "**review-me slash commands**",
          "",
          "| Command | Description |",
          "| --- | --- |",
          "| `/review-me` | Trigger a re-review of this PR immediately. |",
          "| `/review-me re-review` | Same as bare `/review-me`. |",
          "| `/review-me skip` | Stop auto-reviewing this PR (expires after 7 days). |",
          "| `/review-me resume` | Resume auto-reviewing this PR after a skip. |",
          "| `/review-me help` | Show this help message. |",
        ].join("\n");
        try {
          await octokit.issues.createComment({
            owner,
            repo: name,
            issue_number: prNumber,
            body: helpBody,
          });
        } catch (err) {
          // Comment post failures are logged but must not crash the handler.
          log.error("slash command: failed to post help comment", {
            deliveryId: id,
            repo: repoFull,
            pr: prNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      case "skip": {
        skipRegistry.setSkipped(key);
        try {
          await octokit.issues.createComment({
            owner,
            repo: name,
            issue_number: prNumber,
            body: "Got it — I'll stop auto-reviewing this PR. Use `/review-me resume` to re-enable reviews.",
          });
        } catch (err) {
          log.error("slash command: failed to post skip ack", {
            deliveryId: id,
            repo: repoFull,
            pr: prNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      case "resume": {
        skipRegistry.clearSkipped(key);
        try {
          await octokit.issues.createComment({
            owner,
            repo: name,
            issue_number: prNumber,
            body: "Done — auto-reviews are re-enabled for this PR.",
          });
        } catch (err) {
          log.error("slash command: failed to post resume ack", {
            deliveryId: id,
            repo: repoFull,
            pr: prNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      case "unknown": {
        try {
          await octokit.issues.createComment({
            owner,
            repo: name,
            issue_number: prNumber,
            body: `Unknown command \`${parsed.raw}\`. Try \`/review-me help\` to see available commands.`,
          });
        } catch (err) {
          log.error("slash command: failed to post unknown-command ack", {
            deliveryId: id,
            repo: repoFull,
            pr: prNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      case "re-review":
        // Fall through to the existing re-review / mention flow below.
        break;

      default:
        // Exhaustiveness guard — should never be reached with the current
        // command union type.
        parsed.command satisfies never;
        return;
    }

    // --- re-review path (unchanged logic) ---

    // issue_comment doesn't include head SHA; fetch the PR.
    const prData = await octokit.pulls.get({
      owner,
      repo: name,
      pull_number: prNumber,
    });

    const ref: PrRef = {
      owner,
      repo: name,
      pullNumber: prNumber,
      headSha: prData.data.head.sha,
    };

    log.info("/review-me mention triggered review", {
      deliveryId: id,
      repo: repoFull,
      pr: ref.pullNumber,
      commenter,
    });

    await triggerExplicit(ref, repoFull, {
      octokit,
      anthropic,
      selfLogin,
      jiraCreds,
      deliveryId: id,
      source: "mention",
      entry,
    });
  });

  webhooks.on(
    "pull_request_review_comment.created",
    async ({ id, payload }) => {
      try {
        await handleReviewCommentCreated(payload, {
          octokit,
          anthropic,
          selfLogin,
          jiraCreds,
        });
      } catch (err) {
        incThreadReply("error");
        log.error("review comment handler error", {
          evt: "thread.handler_error",
          deliveryId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  return webhooks;
}

/**
 * Explicit triggers (label, mention) re-check CI themselves — they don't go
 * through check_suite.completed, so we need to gate on the latest status.
 */
async function triggerExplicit(
  ref: PrRef,
  repoFull: string,
  deps: PipelineDeps,
): Promise<void> {
  const logFields = {
    deliveryId: deps.deliveryId,
    repo: repoFull,
    pr: ref.pullNumber,
    headSha: ref.headSha,
    source: deps.source,
  };

  try {
    const gate = await evaluateHeadSha(
      deps.octokit,
      ref.owner,
      ref.repo,
      ref.headSha,
    );
    if (!gate.green) {
      log.info("skip explicit trigger: CI not green", {
        ...logFields,
        failingChecks: gate.failingChecks,
      });
      return;
    }

    enqueueOrThrow(
      () => runPipeline(ref, deps),
      { deliveryId: deps.deliveryId, repo: repoFull, pr: ref.pullNumber },
    );
  } catch (err) {
    if (!isReviewError(err)) {
      log.error("explicit trigger failed", {
        ...logFields,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function runPipeline(ref: PrRef, deps: PipelineDeps): Promise<void> {
  const repoFull = `${ref.owner}/${ref.repo}`;
  const logFields = {
    deliveryId: deps.deliveryId,
    repo: repoFull,
    pr: ref.pullNumber,
    headSha: ref.headSha,
    source: deps.source,
  };
  const errorCtx = { repo: repoFull, pr: ref.pullNumber };

  // Early return when a /review-me skip command has been issued for this PR.
  if (skipRegistry.isSkipped(skipKey(repoFull, ref.pullNumber))) {
    log.info("skip.user_requested", {
      ...logFields,
      evt: "skip.user_requested",
    });
    return;
  }

  if (
    await hasExistingReview(
      deps.octokit,
      ref.owner,
      ref.repo,
      ref.pullNumber,
      ref.headSha,
      deps.selfLogin,
    )
  ) {
    log.info("skip review: already reviewed this head SHA", logFields);
    return;
  }

  log.info("starting review", logFields);
  const pipelineStart = Date.now();

  // Stage: diff-fetch
  let diff: Awaited<ReturnType<typeof fetchPullRequestDiff>>;
  try {
    diff = await fetchPullRequestDiff(
      deps.octokit,
      ref.owner,
      ref.repo,
      ref.pullNumber,
    );
  } catch (err) {
    incReviewFailures("fetch-diff", err instanceof Error ? err.message : "unknown");
    const reviewErr = wrapDiffFetchError(err);
    logReviewError(reviewErr, errorCtx, { deliveryId: deps.deliveryId });
    throw reviewErr;
  }

  // Stage: intent-resolve
  let intent: Awaited<ReturnType<typeof resolveIntent>>;
  try {
    intent = await resolveIntent({
      prTitle: diff.title,
      prBody: diff.body,
      branch: "",
      creds: deps.jiraCreds,
    });
  } catch (err) {
    incReviewFailures("resolve-intent", err instanceof Error ? err.message : "unknown");
    // resolveIntent is fail-open by design; an error here is unexpected
    // (e.g. a programming error). We wrap it with a placeholder ticket key.
    const reviewErr = wrapIntentResolveError(err, "(unknown)");
    logReviewError(reviewErr, errorCtx, { deliveryId: deps.deliveryId });
    throw reviewErr;
  }

  // Stage: llm-review
  let result: Awaited<ReturnType<typeof runReview>>["result"];
  let warnings: string[];
  let usage: Awaited<ReturnType<typeof runReview>>["usage"];
  try {
    ({ result, warnings, usage } = await runReview(deps.anthropic, {
      intent,
      diff,
      octokit: deps.octokit,
    }));
  } catch (err) {
    incReviewFailures("llm-review", err instanceof Error ? err.message : "unknown");
    const reviewErr = wrapLlmReviewError(err);
    logReviewError(reviewErr, errorCtx, { deliveryId: deps.deliveryId });
    throw reviewErr;
  }

  // Record token usage for metrics and the per-review usage log.
  if (usage) {
    const u = usage as Record<string, unknown>;
    const pairs: Array<[string, unknown]> = [
      ["input", u["input_tokens"]],
      ["output", u["output_tokens"]],
      ["cache_read", u["cache_read_input_tokens"]],
      ["cache_write", u["cache_creation_input_tokens"]],
    ];
    for (const [kind, count] of pairs) {
      if (typeof count === "number" && count > 0) {
        incAnthropicTokens(kind, count);
      }
    }
  }

  const isTooLarge = warnings.some((w) => w.includes("diff exceeded review threshold"));
  const usageVerdict = isTooLarge ? "too_large" : result.verdict;

  await recordUsage({
    repo: repoFull,
    pr: ref.pullNumber,
    headSha: ref.headSha,
    model: DEFAULT_MODEL,
    verdict: usageVerdict,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadInputTokens,
    cacheCreationTokens: usage?.cacheCreationInputTokens,
  });

  log.info("review.usage", {
    repo: repoFull,
    pr: ref.pullNumber,
    headSha: ref.headSha,
    model: DEFAULT_MODEL,
    verdict: usageVerdict,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadInputTokens ?? 0,
    cacheCreationTokens: usage?.cacheCreationInputTokens ?? 0,
    evt: "review.usage",
  });

  log.info("review produced", {
    ...logFields,
    verdict: result.verdict,
    commentCount: result.lineComments.length,
    intentSource: intent.source,
    intentWarnings: intent.warnings,
    runtimeWarnings: warnings,
    usage,
  });

  // Stage: post-review
  let outcome: Awaited<ReturnType<typeof postReview>>;
  try {
    outcome = await postReview(deps.octokit, {
      owner: ref.owner,
      repo: ref.repo,
      pullNumber: ref.pullNumber,
      headSha: ref.headSha,
      selfLogin: deps.selfLogin,
      review: result,
    });
  } catch (err) {
    incReviewFailures("post-review", err instanceof Error ? err.message : "unknown");
    const reviewErr = wrapPostReviewError(err);
    logReviewError(reviewErr, errorCtx, { deliveryId: deps.deliveryId });
    throw reviewErr;
  }

  const durationSeconds = (Date.now() - pipelineStart) / 1_000;
  observeReviewDuration(durationSeconds);
  incReviewsTotal(repoFull, result.verdict);

  log.info("review posted", { ...logFields, outcome });
}
