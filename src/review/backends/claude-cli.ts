import type { ZodType } from "zod";
import { log } from "../../server/logger";
import type {
  ReviewBackend,
  BackendInvokeRequest,
  BackendInvokeResult,
  BackendUsage,
} from "./types";

// ---------------------------------------------------------------------------
// Types for the JSON envelope emitted by `claude -p --output-format json`
// ---------------------------------------------------------------------------

interface CliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // Some CLI versions expose these names instead / in addition:
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

interface CliMessage {
  role: string;
  content:
    | string
    | Array<{ type: string; text?: string }>;
}

/**
 * The top-level JSON object emitted by `claude --output-format json`.
 *
 * The CLI may emit the usage under `usage` or `total_usage`; we check both.
 */
interface CliEnvelope {
  type?: string;
  role?: string;
  content?: CliMessage["content"];
  // An array of messages (older CLI versions)
  messages?: CliMessage[];
  // Or the assistant message at the top level (newer versions)
  result?: string;
  // Usage may appear at top level or nested
  usage?: CliUsage;
  total_usage?: CliUsage;
  cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the assistant's plain-text content from the CLI envelope.
 *
 * The CLI may structure its output as:
 *   { result: "<text>" }
 *   { content: "<text>" }
 *   { content: [{ type: "text", text: "<text>" }] }
 *   { messages: [{ role: "assistant", content: "<text>" }] }
 *   { messages: [{ role: "assistant", content: [{ type: "text", text: "<text>" }] }] }
 */
function extractAssistantText(envelope: CliEnvelope): string | null {
  // Newer CLI: `result` field is the plain assistant response
  if (typeof envelope.result === "string" && envelope.result.trim()) {
    return envelope.result.trim();
  }

  // Content at top level
  const topContent = envelope.content;
  if (typeof topContent === "string" && topContent.trim()) {
    return topContent.trim();
  }
  if (Array.isArray(topContent)) {
    const texts = topContent
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    const joined = texts.join("").trim();
    if (joined) return joined;
  }

  // Messages array
  if (Array.isArray(envelope.messages)) {
    for (const msg of envelope.messages) {
      if (msg.role !== "assistant") continue;
      if (typeof msg.content === "string" && msg.content.trim()) {
        return msg.content.trim();
      }
      if (Array.isArray(msg.content)) {
        const texts = msg.content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string);
        const joined = texts.join("").trim();
        if (joined) return joined;
      }
    }
  }

  return null;
}

/**
 * Map CLI usage fields to our internal `BackendUsage` shape.
 * Handles both snake_case and camelCase variants the CLI may emit.
 * Missing fields default to 0.
 */
function mapUsage(raw: CliUsage | undefined): BackendUsage {
  if (!raw) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
  }
  return {
    input_tokens:
      raw.input_tokens ?? raw.inputTokens ?? 0,
    output_tokens:
      raw.output_tokens ?? raw.outputTokens ?? 0,
    cache_read_input_tokens:
      raw.cache_read_input_tokens ?? raw.cacheReadInputTokens ?? 0,
    cache_creation_input_tokens:
      raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens ?? 0,
  };
}

/**
 * Build a minimal JSON-shape instruction to embed in the system prompt so
 * the model returns parseable JSON when invoked via the CLI (which has no
 * structured-output SDK support).
 *
 * We use the Zod schema description to generate a concrete shape hint.
 */
function jsonShapeInstruction(): string {
  return (
    `\n\nReturn ONLY a JSON object matching the following TypeScript type, ` +
    `with no prose before or after:\n` +
    `{\n` +
    `  "verdict": "approve" | "comment",\n` +
    `  "summary": string,\n` +
    `  "lineComments": Array<{ "path": string, "line": number, "body": string }>\n` +
    `}`
  );
}

/**
 * Build the JSON-shape instruction for the batch-summary pass (pass 1).
 * Called when the schema has a `file_summaries` key — detected by inspecting
 * the schema description string.
 */
function jsonShapeInstructionBatch(): string {
  return (
    `\n\nReturn ONLY a JSON object matching the following TypeScript type, ` +
    `with no prose before or after:\n` +
    `{\n` +
    `  "file_summaries": Array<{\n` +
    `    "path": string,\n` +
    `    "risks": string[],\n` +
    `    "suspected_bugs": string[],\n` +
    `    "missing_tests": string[],\n` +
    `    "notable_changes": string[]\n` +
    `  }>\n` +
    `}`
  );
}

/**
 * Detect which schema we are dealing with so we can embed the right JSON hint.
 * We do this by checking the Zod schema's `_def` description or the schema
 * object name — both are available at runtime without parsing.
 *
 * Fallback: if the schema has a key called `file_summaries` in its shape, use
 * the batch instruction; otherwise use the review result instruction.
 */
function pickJsonInstruction(schema: ZodType<unknown>): string {
  // ZodObject exposes `shape` at runtime.
  const shape = (schema as { shape?: Record<string, unknown> }).shape;
  if (shape && "file_summaries" in shape) {
    return jsonShapeInstructionBatch();
  }
  return jsonShapeInstruction();
}

// Spawn function type — injectable for testing.
export type SpawnFn = (
  cmd: string[],
  opts: { stdin?: "pipe" | "inherit"; stdout?: "pipe"; stderr?: "pipe" },
) => {
  stdout: { text(): Promise<string> };
  stderr: { text(): Promise<string> };
  exited: Promise<number>;
};

// Default spawn using Bun.spawn.
const defaultSpawn: SpawnFn = (cmd, _opts) => {
  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: { text: () => new Response(proc.stdout).text() },
    stderr: { text: () => new Response(proc.stderr).text() },
    exited: proc.exited,
  };
};

// ---------------------------------------------------------------------------
// ClaudeCliBackend
// ---------------------------------------------------------------------------

export class ClaudeCliBackend implements ReviewBackend {
  private readonly spawnFn: SpawnFn;

  constructor(spawnFn: SpawnFn = defaultSpawn) {
    this.spawnFn = spawnFn;
  }

  async parseReview<T>(
    request: BackendInvokeRequest<T>,
  ): Promise<BackendInvokeResult<T>> {
    const { system, userMessage, schema, repo, pr } = request;

    // Embed JSON shape instruction into the system prompt so the model returns
    // structured JSON even when there is no SDK-level structured output.
    const augmentedSystem = system + pickJsonInstruction(schema);

    const args = [
      "claude",
      "-p",
      userMessage,
      "--append-system-prompt",
      augmentedSystem,
      "--output-format",
      "json",
    ];

    let stdoutText = "";
    let stderrText = "";
    let exitCode = 0;

    try {
      const proc = this.spawnFn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      [stdoutText, stderrText, exitCode] = await Promise.all([
        proc.stdout.text(),
        proc.stderr.text(),
        proc.exited,
      ]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error("backend.spawn_error", {
        evt: "backend.spawn_error",
        backend: "claude-cli",
        repo,
        pr,
        reason,
      });
      return this.fallback<T>(schema, `Claude CLI spawn error: ${reason}`, "");
    }

    if (exitCode !== 0) {
      const reason = stderrText.trim() || `exit code ${exitCode}`;
      log.error("backend.cli_error", {
        evt: "backend.cli_error",
        backend: "claude-cli",
        repo,
        pr,
        exit_code: exitCode,
        stderr_preview: stderrText.slice(0, 300),
      });
      return this.fallback<T>(schema, `Claude CLI exited with code ${exitCode}: ${reason}`, stdoutText);
    }

    // ── Parse the JSON envelope ──────────────────────────────────────────────

    let envelope: CliEnvelope;
    try {
      envelope = JSON.parse(stdoutText) as CliEnvelope;
    } catch {
      log.warn("backend.schema_fallback", {
        evt: "backend.schema_fallback",
        backend: "claude-cli",
        repo,
        pr,
        reason: "envelope_json_parse_failed",
        raw_preview: stdoutText.slice(0, 300),
      });
      return this.fallback<T>(schema, "CLI output was not valid JSON", stdoutText);
    }

    if (envelope.is_error) {
      const errPreview = stdoutText.slice(0, 300);
      log.warn("backend.schema_fallback", {
        evt: "backend.schema_fallback",
        backend: "claude-cli",
        repo,
        pr,
        reason: "cli_is_error_flag",
        raw_preview: errPreview,
      });
      return this.fallback<T>(schema, "Claude CLI returned an error envelope", stdoutText);
    }

    const rawUsage = envelope.usage ?? envelope.total_usage;
    const usage = mapUsage(rawUsage);

    // ── Extract assistant text ───────────────────────────────────────────────

    const assistantText = extractAssistantText(envelope);
    if (!assistantText) {
      log.warn("backend.schema_fallback", {
        evt: "backend.schema_fallback",
        backend: "claude-cli",
        repo,
        pr,
        reason: "no_assistant_text",
        raw_preview: stdoutText.slice(0, 300),
      });
      return this.fallback<T>(schema, "Could not locate assistant text in CLI response", stdoutText, usage);
    }

    // ── Parse assistant text as JSON and validate against schema ─────────────

    let parsed: unknown;
    try {
      parsed = JSON.parse(assistantText);
    } catch {
      log.warn("backend.schema_fallback", {
        evt: "backend.schema_fallback",
        backend: "claude-cli",
        repo,
        pr,
        reason: "content_json_parse_failed",
        raw_preview: assistantText.slice(0, 300),
      });
      return this.fallback<T>(schema, "Assistant content was not valid JSON", stdoutText, usage);
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      log.warn("backend.schema_fallback", {
        evt: "backend.schema_fallback",
        backend: "claude-cli",
        repo,
        pr,
        reason: "schema_validation_failed",
        zod_error: result.error.issues.map((i) => i.message).join("; "),
        raw_preview: assistantText.slice(0, 300),
      });
      return this.fallback<T>(schema, "CLI response did not match expected schema", stdoutText, usage);
    }

    return {
      parsedOutput: result.data,
      usage,
      raw: stdoutText,
    };
  }

  /**
   * Returns a graceful fallback result when the CLI output cannot be parsed or
   * validated.  Never throws.
   *
   * The fallback shape needs to be compatible with T (which is either
   * ReviewResult or BatchSummary).  We detect which by inspecting the schema
   * shape (same logic as pickJsonInstruction).
   */
  private fallback<T>(
    schema: ZodType<T>,
    _reason: string,
    raw: string,
    usage: BackendUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  ): BackendInvokeResult<T> {
    const shape = (schema as { shape?: Record<string, unknown> }).shape;
    const isBatch = shape && "file_summaries" in shape;

    const parsedOutput = isBatch
      ? ({ file_summaries: [] } as unknown as T)
      : ({
          verdict: "comment",
          summary:
            "Review backend returned an unparseable response; human review recommended.",
          lineComments: [],
        } as unknown as T);

    return { parsedOutput, usage, raw };
  }
}

// ---------------------------------------------------------------------------
// Version-check helper — exported for use by the backend factory
// ---------------------------------------------------------------------------

/**
 * Run `claude --version` with a 5-second timeout.
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` otherwise.
 *
 * The `spawnFn` parameter enables injection for testing.
 */
export async function checkClaudeCliAvailable(
  spawnFn: SpawnFn = defaultSpawn,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const TIMEOUT_MS = 5_000;

  let stdoutText = "";
  let exitCode = 0;

  try {
    const proc = spawnFn(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS),
    );

    const run = Promise.all([
      proc.stdout.text(),
      proc.stderr.text(),
      proc.exited,
    ]).then(([out, , code]) => {
      stdoutText = out;
      exitCode = code;
    });

    await Promise.race([run, timeout]);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }

  if (exitCode !== 0) {
    return { ok: false, reason: `claude --version exited with code ${exitCode}` };
  }

  if (!stdoutText.trim()) {
    return { ok: false, reason: "claude --version produced no output" };
  }

  return { ok: true };
}
