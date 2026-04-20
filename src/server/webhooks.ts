import { Webhooks } from "@octokit/webhooks";
import type Anthropic from "@anthropic-ai/sdk";
import type { RepoAllowlist } from "../config";
import {
  evaluateHeadSha,
  fetchPullRequestDiff,
  hasExistingReview,
  postReview,
  type Octokit,
} from "../github";
import { resolveIntent, type JiraCredentials } from "../jira";
import { runReview } from "../review";
import { log } from "./logger";

export type WebhookDeps = {
  allowlist: RepoAllowlist;
  octokit: Octokit;
  anthropic: Anthropic;
  selfLogin: string;
  jiraCreds?: JiraCredentials;
};

type PrRef = { owner: string; repo: string; pullNumber: number; headSha: string };

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
    // CI has not completed yet — wait for check_suite.completed.
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
    // Re-review policy lands in Phase 7; check_suite.completed still gates.
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
    const repo = payload.repository.full_name;
    if (!allowlist.isAllowed(repo)) {
      log.debug("skip: repo not allowlisted", { deliveryId: id, repo });
      return;
    }

    const [owner, name] = repo.split("/");
    if (!owner || !name) return;

    const headSha = payload.check_suite.head_sha;
    const prs = payload.check_suite.pull_requests;
    if (prs.length === 0) return;

    const gate = await evaluateHeadSha(octokit, owner, name, headSha);
    log.info("check_suite.completed", {
      deliveryId: id,
      repo,
      conclusion: payload.check_suite.conclusion,
      headSha,
      prCount: prs.length,
      gateGreen: gate.green,
    });

    if (!gate.green) {
      log.info("skip review: CI not green", {
        deliveryId: id,
        repo,
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
        await reviewPullRequest(ref, {
          octokit,
          anthropic,
          selfLogin,
          jiraCreds,
          deliveryId: id,
        });
      } catch (err) {
        log.error("review pipeline failed", {
          deliveryId: id,
          repo,
          pr: ref.pullNumber,
          headSha,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  return webhooks;
}

type ReviewDeps = {
  octokit: Octokit;
  anthropic: Anthropic;
  selfLogin: string;
  jiraCreds?: JiraCredentials;
  deliveryId: string;
};

async function reviewPullRequest(ref: PrRef, deps: ReviewDeps): Promise<void> {
  const repoFull = `${ref.owner}/${ref.repo}`;
  const logFields = {
    deliveryId: deps.deliveryId,
    repo: repoFull,
    pr: ref.pullNumber,
    headSha: ref.headSha,
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
