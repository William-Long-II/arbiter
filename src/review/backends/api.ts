import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type Anthropic from "@anthropic-ai/sdk";
import { withRetry } from "../../util/retry";
import { withBreaker } from "../breaker";
import type { ReviewBackend, BackendInvokeRequest, BackendInvokeResult } from "./types";

/**
 * API backend — thin wrapper around `anthropic.messages.parse`.
 *
 * Preserves all existing behaviour:
 *   - Prompt caching via `cache_control: { type: "ephemeral" }` on the system block.
 *   - `thinking: { type: "adaptive" }`.
 *   - Circuit-breaker + withRetry wrapping.
 *   - Throws on schema validation failure (`.parsed_output` is null/undefined).
 *
 * This backend is the default when `LLM_BACKEND` is unset or set to `api`.
 */
export class ApiBackend implements ReviewBackend {
  private readonly anthropic: Anthropic;

  constructor(anthropic: Anthropic) {
    this.anthropic = anthropic;
  }

  /**
   * Override the underlying Anthropic client at call time (used by
   * `runReview`/`runChunkedReview` to honour per-repo key overrides).
   */
  withClient(client: Anthropic): ApiBackend {
    return new ApiBackend(client);
  }

  async parseReview<T>(
    request: BackendInvokeRequest<T>,
  ): Promise<BackendInvokeResult<T>> {
    const { system, userMessage, schema, model, maxTokens } = request;

    const response = await withBreaker("anthropic", () =>
      withRetry(() =>
        this.anthropic.messages.parse({
          model,
          max_tokens: maxTokens,
          thinking: { type: "adaptive" },
          system: [
            {
              type: "text",
              text: system,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [{ role: "user", content: userMessage }],
          output_config: {
            format: zodOutputFormat(schema),
          },
        } as Parameters<typeof this.anthropic.messages.parse>[0]),
      ),
    );

    if (!response.parsed_output) {
      throw new Error("LLM returned a response that did not match the schema");
    }

    return {
      parsedOutput: response.parsed_output as T,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens:
          response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
