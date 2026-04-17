import { Webhooks } from "@octokit/webhooks";
import { log } from "./logger";

export function createWebhooks(secret: string): Webhooks {
  const webhooks = new Webhooks({ secret });

  webhooks.on("pull_request.opened", async ({ id, payload }) => {
    log.info("pull_request.opened", {
      deliveryId: id,
      repo: payload.repository.full_name,
      pr: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
    });
    // Phase 3+ will enqueue a review attempt (awaiting CI green).
  });

  webhooks.on("pull_request.synchronize", async ({ id, payload }) => {
    log.info("pull_request.synchronize", {
      deliveryId: id,
      repo: payload.repository.full_name,
      pr: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
    });
    // Phase 7 will honor per-repo re-review config.
  });

  webhooks.on("pull_request.reopened", async ({ id, payload }) => {
    log.info("pull_request.reopened", {
      deliveryId: id,
      repo: payload.repository.full_name,
      pr: payload.pull_request.number,
    });
  });

  webhooks.on("check_suite.completed", async ({ id, payload }) => {
    log.info("check_suite.completed", {
      deliveryId: id,
      repo: payload.repository.full_name,
      conclusion: payload.check_suite.conclusion,
      headSha: payload.check_suite.head_sha,
      prCount: payload.check_suite.pull_requests.length,
    });
    // Phase 3 will resolve PR(s), gate on conclusion === 'success', and trigger review.
  });

  return webhooks;
}
