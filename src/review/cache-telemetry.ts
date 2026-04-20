import { log } from "../server/logger";
import {
  incPromptCacheRead,
  incPromptCacheCreation,
} from "../server/metrics";

export interface CacheTelemetryInput {
  repo: string;
  pr: number;
  headSha: string;
  /** Raw Anthropic usage object from a single response. */
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  /** Which review pass produced this response. */
  mode: "single" | "chunked-pass-1" | "chunked-pass-2";
}

/**
 * Records Anthropic prompt-cache telemetry for one LLM response.
 *
 * Logs a structured `prompt.cache` event at info level and bumps the
 * `reviewme_prompt_cache_read_tokens_total` /
 * `reviewme_prompt_cache_creation_tokens_total` counters.
 *
 * Suppressed (no log, no counter bump) when all cache token fields are zero
 * — this avoids noise on the first cold call where caching hasn't kicked in
 * yet and there is genuinely nothing to report.
 *
 * Never throws: missing / null usage fields default to 0.
 */
export function recordCacheTelemetry(input: CacheTelemetryInput): void {
  const { repo, pr, headSha, usage, mode } = input;

  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const inputTokens = usage.input_tokens ?? 0;

  // Guard: nothing cache-related happened — skip to keep logs clean.
  if (cacheRead === 0 && cacheCreation === 0) return;

  const total = inputTokens + cacheRead + cacheCreation;
  // Divide-by-zero guard: if somehow total is 0 with non-zero cache fields
  // (shouldn't happen in practice) we report 0 rather than NaN/Infinity.
  const hitRatio = total > 0 ? cacheRead / total : 0;

  log.info("prompt.cache", {
    evt: "prompt.cache",
    repo,
    pr,
    headSha,
    mode,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
    input_tokens: inputTokens,
    hit_ratio: hitRatio,
  });

  incPromptCacheRead(cacheRead);
  incPromptCacheCreation(cacheCreation);
}
