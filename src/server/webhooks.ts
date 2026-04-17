import { Webhooks } from "@octokit/webhooks";
import type { RepoAllowlist } from "../config";
import { evaluateHeadSha, type Octokit } from "../github";
import { log } from "./logger";

export type WebhookDeps = {
  allowlist: RepoAllowlist;
  octokit: Octokit;
};

export function createWebhooks(secret: string, deps: WebhookDeps): Webhooks {
  const webhooks = new Webhooks({ secret });
  const { allowlist, octokit } = deps;

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

    const gate = await evaluateHeadSha(octokit, owner, name, headSha);

    log.info("check_suite.completed", {
      deliveryId: id,
      repo,
      conclusion: payload.check_suite.conclusion,
      headSha,
      prCount: prs.length,
      gate,
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
      log.info("would trigger review", {
        deliveryId: id,
        repo,
        pr: pr.number,
        headSha,
      });
      // Phase 5 will run the LLM pipeline here.
    }
  });

  return webhooks;
}
