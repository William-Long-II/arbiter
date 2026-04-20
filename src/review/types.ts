import type { PullRequestDiff } from "../github";
import type { Intent } from "../jira";
import type { RepoReviewConfig } from "../config/repos";
import type { ReviewResult } from "./schema";

export const DEFAULT_MODEL = "claude-opus-4-7";
export const DEFAULT_MAX_TOKENS = 16_000;
export const DEFAULT_MAX_DIFF_CHARS = 150_000;

export type RunReviewInput = {
  intent: Intent;
  diff: PullRequestDiff;
  /** Per-repo filter config from `repos.yaml`. When absent, only built-in
   *  rules (lockfiles, binaries, etc.) are applied. */
  reviewConfig?: RepoReviewConfig;
};

export type RunReviewOptions = {
  model?: string;
  maxTokens?: number;
  maxDiffChars?: number;
};

export type RunReviewOutput = {
  result: ReviewResult;
  warnings: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
};
