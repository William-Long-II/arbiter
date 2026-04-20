import { Webhooks } from "@octokit/webhooks";
import type Anthropic from "@anthropic-ai/sdk";
import type { RepoAllowlist, RepoEntry } from "../config";
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
import { runReview } from "../review";
import { log } from "./logger";
import { decideFromCheckSuite, mentionsReviewCommand } from "./triggers";

export type WebhookDeps = {
  allowlist: RepoAllowlist;
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

type TriggerSource = "check-suite" | "label" | "mention";

type PipelineDeps = {
  octokit: Octokit;
  anthropic: Anthropic;
  selfLogin: string;
  jiraCreds?: JiraCredentials;
  deliveryId: string;
  source: TriggerSource;
  entry: RepoEntry;
};

export function createWebhooks(secret: string, deps: WebhookDeps): Webhooks {
  const webhooks = new Webhooks({ secret });
  const { allowlist, octokit, anthropic, selfLogin, jiraCreds } = deps;

  webhooks.on("pull_request.opened", async ({ id, payload }) => {
    const repo = payload.repository.full_name;
    if (!allowlist.isAllowed(repo)) {
      log.debug("skip: repo not allowlisted", { deliveryId: id, repo });
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
    if (!allowlist.isAllowed(repo)) return;
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
    if (!allowlist.isAllowed(repo)) return;
    log.info("pull_request.reopened", {
      deliveryId: id,
      repo,
      pr: payload.pull_request.number,
    });
  });

  webhooks.on("check_suite.completed", async ({ id, payload }) => {
    const repoFull = payload.repository.full_name;
    const entry = allowlist.get(repoFull);
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

        await runPipeline(ref, {
          octokit,
          anthropic,
          selfLogin,
          jiraCreds,
          deliveryId: id,
          source: "check-suite",
          entry,
        });

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
        log.error("review pipeline failed", {
          deliveryId: id,
          repo: repoFull,
          pr: ref.pullNumber,
          headSha,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  webhooks.on("pull_request.labeled", async ({ id, payload }) => {
    const repoFull = payload.repository.full_name;
    const entry = allowlist.get(repoFull);
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
    const entry = allowlist.get(repoFull);
    if (!entry?.enabled) return;

    if (!mentionsReviewCommand(payload.comment.body)) return;
    // Don't trigger on the bot's own comments.
    if (payload.comment.user?.login === selfLogin) return;

    const [owner, name] = repoFull.split("/");
    if (!owner || !name) return;

    // issue_comment doesn't include head SHA; fetch the PR.
    const prData = await octokit.pulls.get({
      owner,
      repo: name,
      pull_number: payload.issue.number,
    });

    const ref: PrRef = {
      owner,
      repo: name,
      pullNumber: payload.issue.number,
      headSha: prData.data.head.sha,
    };

    log.info("/review-me mention triggered review", {
      deliveryId: id,
      repo: repoFull,
      pr: ref.pullNumber,
      commenter: payload.comment.user?.login,
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

    await runPipeline(ref, deps);
  } catch (err) {
    log.error("explicit trigger failed", {
      ...logFields,
      error: err instanceof Error ? err.message : String(err),
    });
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

  const diff = await fetchPullRequestDiff(
    deps.octokit,
    ref.owner,
    ref.repo,
    ref.pullNumber,
  );

  const intent = await resolveIntent({
    prTitle: diff.title,
    prBody: diff.body,
    branch: "",
    creds: deps.jiraCreds,
  });

  const { result, warnings, usage } = await runReview(deps.anthropic, {
    intent,
    diff,
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

  const outcome = await postReview(deps.octokit, {
    owner: ref.owner,
    repo: ref.repo,
    pullNumber: ref.pullNumber,
    headSha: ref.headSha,
    selfLogin: deps.selfLogin,
    review: result,
  });

  log.info("review posted", { ...logFields, outcome });
}
