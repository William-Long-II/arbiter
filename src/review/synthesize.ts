import { createHash } from "node:crypto";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { ReviewResultSchema } from "./schema";
import { planReview, toFileDiffs, DEFAULT_BATCH_BUDGET_CHARS } from "./chunker";
import type { FileDiff } from "./chunker";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
import { recordUsage } from "./usage";
import { writeAuditRecord } from "./audit";
import {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  type RunReviewInput,
  type RunReviewOutput,
  type RunReviewOptions,
} from "./types";
import { filterDiff } from "./diff-filter";
import { log } from "../server/logger";
import { recordCacheTelemetry } from "./cache-telemetry";
import { resolveAnthropicClient } from "./client";
import { observePromptUserBytes } from "../server/metrics";
import { getReviewBackend, ApiBackend } from "./backends";

// ─── Pass-1 schema ───────────────────────────────────────────────────────────

const FileSummarySchema = z.object({
  path: z.string().describe("Repository-relative file path."),
  risks: z
    .array(z.string())
    .describe("Security, correctness, or data-integrity risks."),
  suspected_bugs: z
    .array(z.string())
    .describe("Likely bugs or logic errors observed in this file."),
  missing_tests: z
    .array(z.string())
    .describe("Specific code paths or branches that lack test coverage."),
  notable_changes: z
    .array(z.string())
    .describe(
      "Key changes worth highlighting to the pass-2 synthesizer (e.g. API surface changes, algorithm changes).",
    ),
});

export type FileSummary = z.infer<typeof FileSummarySchema>;

const BatchSummarySchema = z.object({
  file_summaries: z
    .array(FileSummarySchema)
    .describe("One entry per file in this batch."),
});

export type BatchSummary = z.infer<typeof BatchSummarySchema>;

// ─── Hunk validation ─────────────────────────────────────────────────────────

/**
 * Parses `@@ -a,b +c,d @@` hunk headers and returns the set of new-file line
 * numbers that appear in the diff hunk (lines c through c+d-1 inclusive).
 *
 * Only lines whose patch representation starts with `+` (added) or ` ` (context)
 * are counted — those are the lines that actually exist in the new file.
 */
export function validLinesInPatch(patch: string): Set<number> {
  const valid = new Set<number>();
  if (!patch) return valid;

  const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  let currentLine = 0;

  for (const rawLine of patch.split("\n")) {
    const headerMatch = hunkHeaderRe.exec(rawLine);
    if (headerMatch) {
      currentLine = parseInt(headerMatch[1]!, 10);
      continue;
    }

    if (rawLine.startsWith("-")) {
      // Deleted line: exists in old file only, no new-file line number to advance.
      continue;
    }

    if (rawLine.startsWith("+") || rawLine.startsWith(" ") || rawLine === "") {
      // Added or context line: exists in new file.
      valid.add(currentLine);
      currentLine++;
    }
  }

  return valid;
}

// ─── Pass-1 helpers ──────────────────────────────────────────────────────────

function buildBatchUserMessage(
  batch: FileDiff[],
  intentSection: string,
): string {
  const parts: string[] = [
    intentSection,
    "",
    "## Files in this batch",
  ];

  for (const file of batch) {
    parts.push("");
    parts.push(
      `### ${file.path} (${file.status}, +${file.additions} / -${file.deletions})`,
    );
    if (file.previous_path) {
      parts.push(`Renamed from: ${file.previous_path}`);
    }
    parts.push("```diff");
    parts.push(file.patch || "// no patch available");
    parts.push("```");
  }

  return parts.join("\n");
}

const BATCH_SYSTEM_PROMPT = `You are review-me, an intent-aware pull-request reviewer performing the first pass of a two-pass review.

Your job for this pass: summarize each file's key changes, risks, suspected bugs, and missing test coverage. Be precise and terse. Do not produce a final verdict — that comes in pass two.

Rules:
- Output only the fields defined by the schema. No preamble.
- Every file in the batch must have an entry in file_summaries.
- risks: security, correctness, data-integrity concerns you actually see in the patch.
- suspected_bugs: concrete logic errors, off-by-ones, wrong error handling.
- missing_tests: only call out paths that are genuinely untested (not general "add more tests").
- notable_changes: API surface changes, algorithm swaps, schema changes — things the synthesizer needs to know for cross-file reasoning.
- Keep each list item to one sentence.`;

// ─── Pass-2 helpers ──────────────────────────────────────────────────────────

function buildSynthesisUserMessage(
  intentSection: string,
  batchSummaries: BatchSummary[],
): string {
  const parts: string[] = [
    intentSection,
    "",
    "## File-by-file summaries (from pass 1)",
  ];

  for (const summary of batchSummaries) {
    for (const fs of summary.file_summaries) {
      parts.push("");
      parts.push(`### ${fs.path}`);
      if (fs.notable_changes.length > 0) {
        parts.push("**Notable changes:**");
        for (const c of fs.notable_changes) parts.push(`- ${c}`);
      }
      if (fs.risks.length > 0) {
        parts.push("**Risks:**");
        for (const r of fs.risks) parts.push(`- ${r}`);
      }
      if (fs.suspected_bugs.length > 0) {
        parts.push("**Suspected bugs:**");
        for (const b of fs.suspected_bugs) parts.push(`- ${b}`);
      }
      if (fs.missing_tests.length > 0) {
        parts.push("**Missing tests:**");
        for (const t of fs.missing_tests) parts.push(`- ${t}`);
      }
    }
  }

  parts.push("");
  parts.push(
    "Synthesize the above summaries into a final review verdict and line comments. " +
      "Only emit line comments for lines that exist in the actual diff hunks you can reason about from the summaries.",
  );

  return parts.join("\n");
}

/** Extracts just the intent + PR header section from buildUserMessage output. */
function buildIntentSection(input: RunReviewInput): string {
  // We only need the intent + PR description blocks — not the diff section.
  // buildUserMessage produces that naturally; we just strip the ## Diff block.
  const full = buildUserMessage({
    intent: input.intent,
    diff: input.diff,
  });
  const diffIdx = full.indexOf("\n## Diff");
  return diffIdx >= 0 ? full.slice(0, diffIdx) : full;
}

// ─── Concurrency helper ───────────────────────────────────────────────────────

const BATCH_CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);

  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const sliceResults = await Promise.all(
      slice.map((item, j) => fn(item, i + j)),
    );
    for (let j = 0; j < sliceResults.length; j++) {
      results[i + j] = sliceResults[j]!;
    }
  }

  return results;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Two-pass chunked review for large PRs:
 *   Pass 1 — summarize each batch of files in parallel (up to 3 concurrent).
 *   Pass 2 — synthesize all summaries into a final `ReviewResult`.
 *
 * Fails the entire review (throws) if any pass-1 batch fails — partial
 * synthesis would produce unreliable results. Pass-2 overflow is single-shot;
 * we log a warning if it occurs.
 */
export async function runChunkedReview(
  anthropic: Anthropic,
  input: RunReviewInput,
  options: RunReviewOptions = {},
): Promise<RunReviewOutput> {
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Resolve a per-repo Anthropic client once; reused for both pass-1 and pass-2
  // so a single override key is used consistently throughout this review.
  const effectiveClient = resolveAnthropicClient(input.reviewConfig, anthropic);

  // Apply the same diff filter as the single-pass path so we skip lockfiles etc.
  const filterResult = filterDiff(input.diff.files, {
    include: input.reviewConfig?.include_paths,
    exclude: input.reviewConfig?.exclude_paths,
  });

  const omittedPaths = new Set(filterResult.omitted.map((o) => o.path));
  const keptFiles = input.diff.files.filter(
    (f) => !omittedPaths.has(f.filename),
  );

  const fileDiffs = toFileDiffs(keptFiles);
  const plan = planReview(fileDiffs, DEFAULT_BATCH_BUDGET_CHARS);

  log.info("[chunked-review] pass-1 starting", {
    pr: `${input.diff.owner}/${input.diff.repo}#${input.diff.number}`,
    batches: plan.batches.length,
    files: fileDiffs.length,
  });

  const intentSection = buildIntentSection(input);

  // ── Pass 1: summarize each batch ─────────────────────────────────────────

  // Aggregate usage across all pass-1 calls.
  let pass1InputTokens = 0;
  let pass1OutputTokens = 0;
  let pass1CacheCreation = 0;
  let pass1CacheRead = 0;

  const batchSummaries = await mapWithConcurrency(
    plan.batches,
    async (batch, batchIdx) => {
      log.info("[chunked-review] pass-1 batch start", {
        batchIdx,
        files: batch.map((f) => f.path),
      });

      const userMessage = buildBatchUserMessage(batch, intentSection);

      // Select backend for this call — per-repo client override honoured for api path.
      const batchBackend =
        process.env["LLM_BACKEND"] === "claude-cli"
          ? getReviewBackend()
          : new ApiBackend(effectiveClient);

      const { parsedOutput: batchParsed, usage: batchUsage } =
        await batchBackend.parseReview({
          system: BATCH_SYSTEM_PROMPT,
          userMessage,
          schema: BatchSummarySchema,
          model,
          maxTokens,
          repo: `${input.diff.owner}/${input.diff.repo}`,
          pr: input.diff.number,
        });

      pass1InputTokens += batchUsage.input_tokens;
      pass1OutputTokens += batchUsage.output_tokens;
      pass1CacheCreation += batchUsage.cache_creation_input_tokens;
      pass1CacheRead += batchUsage.cache_read_input_tokens;

      log.info("[chunked-review] pass-1 batch end", {
        batchIdx,
        files: batch.map((f) => f.path),
      });

      return batchParsed as BatchSummary;
    },
    BATCH_CONCURRENCY,
  );

  // Record pass-1 usage.
  await recordUsage({
    repo: `${input.diff.owner}/${input.diff.repo}`,
    pr: input.diff.number,
    headSha: input.diff.headSha,
    model,
    verdict: "chunked_pass_1",
    inputTokens: pass1InputTokens,
    outputTokens: pass1OutputTokens,
    cacheCreationTokens: pass1CacheCreation,
    cacheReadTokens: pass1CacheRead,
    pass: 1,
  });

  recordCacheTelemetry({
    repo: `${input.diff.owner}/${input.diff.repo}`,
    pr: input.diff.number,
    headSha: input.diff.headSha,
    usage: {
      input_tokens: pass1InputTokens,
      cache_read_input_tokens: pass1CacheRead,
      cache_creation_input_tokens: pass1CacheCreation,
    },
    mode: "chunked-pass-1",
  });

  // Persist audit record for pass 1.
  await writeAuditRecord({
    repo: `${input.diff.owner}/${input.diff.repo}`,
    pr: input.diff.number,
    headSha: input.diff.headSha,
    mode: "chunked-pass-1",
    promptSystem: BATCH_SYSTEM_PROMPT,
    // Summarise all batch user messages as a JSON array for auditing.
    promptUser: JSON.stringify(
      plan.batches.map((batch) => buildBatchUserMessage(batch, intentSection)),
    ),
    responseRaw: batchSummaries,
    usage: {
      inputTokens: pass1InputTokens,
      outputTokens: pass1OutputTokens,
      cacheCreationInputTokens: pass1CacheCreation,
      cacheReadInputTokens: pass1CacheRead,
    },
    verdict: "chunked_pass_1",
    warnings: [],
  });

  log.info("[chunked-review] pass-1 complete", {
    pr: `${input.diff.owner}/${input.diff.repo}#${input.diff.number}`,
    inputTokens: pass1InputTokens,
    outputTokens: pass1OutputTokens,
  });

  // ── Pass 2: synthesize ────────────────────────────────────────────────────

  log.info("[chunked-review] pass-2 starting", {
    pr: `${input.diff.owner}/${input.diff.repo}#${input.diff.number}`,
  });

  const synthesisMessage = buildSynthesisUserMessage(intentSection, batchSummaries);

  // Observe pass-2 synthesis prompt size for capacity planning (issue #77).
  const synthesisMessageBytes = Buffer.byteLength(synthesisMessage, "utf8");
  observePromptUserBytes(synthesisMessageBytes);
  if (synthesisMessageBytes >= 1024) {
    log.info("prompt.size", {
      evt: "prompt.size",
      repo: `${input.diff.owner}/${input.diff.repo}`,
      pr: input.diff.number,
      headSha: input.diff.headSha,
      user_message_bytes: synthesisMessageBytes,
      mode: "chunked",
    });
  }

  // Select backend for pass-2 synthesis.
  const synthBackend =
    process.env["LLM_BACKEND"] === "claude-cli"
      ? getReviewBackend()
      : new ApiBackend(effectiveClient);

  const { parsedOutput: rawResult, usage: synthUsage } =
    await synthBackend.parseReview({
      system: SYSTEM_PROMPT,
      userMessage: synthesisMessage,
      schema: ReviewResultSchema,
      model,
      maxTokens,
      repo: `${input.diff.owner}/${input.diff.repo}`,
      pr: input.diff.number,
    });

  // Record pass-2 usage.
  await recordUsage({
    repo: `${input.diff.owner}/${input.diff.repo}`,
    pr: input.diff.number,
    headSha: input.diff.headSha,
    model,
    verdict: rawResult.verdict,
    inputTokens: synthUsage.input_tokens,
    outputTokens: synthUsage.output_tokens,
    cacheCreationTokens: synthUsage.cache_creation_input_tokens || undefined,
    cacheReadTokens: synthUsage.cache_read_input_tokens || undefined,
    pass: 2,
  });

  recordCacheTelemetry({
    repo: `${input.diff.owner}/${input.diff.repo}`,
    pr: input.diff.number,
    headSha: input.diff.headSha,
    usage: {
      input_tokens: synthUsage.input_tokens,
      output_tokens: synthUsage.output_tokens,
      cache_read_input_tokens: synthUsage.cache_read_input_tokens,
      cache_creation_input_tokens: synthUsage.cache_creation_input_tokens,
    },
    mode: "chunked-pass-2",
  });

  // Persist audit record for pass 2.
  await writeAuditRecord({
    repo: `${input.diff.owner}/${input.diff.repo}`,
    pr: input.diff.number,
    headSha: input.diff.headSha,
    mode: "chunked-pass-2",
    promptSystem: SYSTEM_PROMPT,
    promptUser: synthesisMessage,
    responseRaw: rawResult,
    usage: {
      inputTokens: synthUsage.input_tokens,
      outputTokens: synthUsage.output_tokens,
      cacheCreationInputTokens: synthUsage.cache_creation_input_tokens || undefined,
      cacheReadInputTokens: synthUsage.cache_read_input_tokens || undefined,
    },
    verdict: rawResult.verdict,
    warnings: [],
  });

  log.info("[chunked-review] pass-2 complete", {
    pr: `${input.diff.owner}/${input.diff.repo}#${input.diff.number}`,
    verdict: rawResult.verdict,
    inputTokens: synthUsage.input_tokens,
    outputTokens: synthUsage.output_tokens,
  });

  // ── Validate line comments against actual diff hunks ──────────────────────

  // Build a map of path → valid new-file line numbers from real diff hunks.
  const validLinesByPath = new Map<string, Set<number>>();
  for (const fd of fileDiffs) {
    validLinesByPath.set(fd.path, validLinesInPatch(fd.patch));
  }

  const warnings: string[] = [];
  const validatedComments = rawResult.lineComments.filter((comment) => {
    const validLines = validLinesByPath.get(comment.path);
    if (!validLines || !validLines.has(comment.line)) {
      const warn = `[chunked-review] dropping line comment on ${comment.path}:${comment.line} — not in any diff hunk`;
      log.warn(warn, { path: comment.path, line: comment.line });
      warnings.push(warn);
      return false;
    }
    return true;
  });

  // Compute prompt hash from the pass-2 synthesis message — that is the final
  // user message actually sent to the LLM and is the most meaningful fingerprint
  // for traceability purposes.
  const promptHash = createHash("sha256")
    .update(synthesisMessage)
    .digest("hex")
    .slice(0, 12);

  return {
    result: {
      ...rawResult,
      lineComments: validatedComments,
    },
    warnings,
    usage: {
      inputTokens: pass1InputTokens + synthUsage.input_tokens,
      outputTokens: pass1OutputTokens + synthUsage.output_tokens,
      cacheCreationInputTokens:
        pass1CacheCreation + synthUsage.cache_creation_input_tokens,
      cacheReadInputTokens:
        pass1CacheRead + synthUsage.cache_read_input_tokens,
    },
    traceMetadata: {
      headSha: input.diff.headSha,
      model,
      mode: "chunked" as const,
      intentSource: input.intent.source,
      intentRef: input.intent.ticketKey ?? "",
      promptHash,
      ts: new Date().toISOString(),
    },
  };
}
