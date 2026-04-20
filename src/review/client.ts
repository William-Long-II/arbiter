import Anthropic from "@anthropic-ai/sdk";
import type { RepoReviewConfig } from "../config/repos";
import { log } from "../server/logger";

export function createAnthropic(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}

/**
 * Returns the Anthropic client to use for a given review.
 *
 * If `reviewConfig.anthropic_api_key_env` names an environment variable that
 * is present and non-empty, a fresh client is constructed with that key and
 * returned (debug log).  If the env var is configured but missing, the default
 * client is returned after a warn log — we prefer a degraded review over a
 * hard failure.  If the field is absent, the default client is returned with
 * no logging.
 *
 * The value is an env-var *name*, not the key itself — this deliberately keeps
 * secrets out of repos.yaml (the name is safe to commit; the key is not).
 */
export function resolveAnthropicClient(
  reviewConfig: RepoReviewConfig | null | undefined,
  defaultClient: Anthropic,
): Anthropic {
  const envVarName = reviewConfig?.anthropic_api_key_env;
  if (!envVarName) {
    return defaultClient;
  }

  const apiKey = process.env[envVarName];
  if (apiKey) {
    log.debug("anthropic.override", { evt: "anthropic.override", env_var_name: envVarName });
    return new Anthropic({ apiKey });
  }

  log.warn("anthropic.override_missing", { evt: "anthropic.override_missing", env_var_name: envVarName });
  return defaultClient;
}

export type { Anthropic };
