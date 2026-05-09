// Pure helpers for the review runner — kept separate so they can be unit-
// tested without mocking Bun.spawn or Anthropic SDK.

export type ReviewInput = {
  scrutiny: 'light' | 'standard' | 'strict';
  diff: string;
  prTitle: string;
  prAuthor: string;
  repoFull: string;
};

export type ReviewOutput = {
  body: string;
  costUsd?: number;
  /** Raw underlying response for debugging — not persisted. */
  raw?: unknown;
};

/**
 * Build the user message we send to Claude. Includes PR metadata and the
 * unified diff in a fenced block so Claude knows to read it as code.
 *
 * The diff fence uses a longer backtick run than anything that appears
 * inside the diff so a literal "```" in the patch can't close the block
 * early. CommonMark allows fences of >= 3 backticks; the closing fence
 * must match the opening length, so we choose `openingTicks` to be one
 * longer than the longest run already in the diff.
 */
export function formatUserMessage(input: ReviewInput): string {
  const fence = pickFence(input.diff);
  return [
    `Please review the following pull request.`,
    ``,
    `Repository: ${input.repoFull}`,
    `PR title: ${input.prTitle}`,
    `Author: ${input.prAuthor}`,
    `Scrutiny tier: ${input.scrutiny}`,
    ``,
    `Unified diff:`,
    `${fence}diff`,
    input.diff,
    fence,
  ].join('\n');
}

function pickFence(content: string): string {
  let longest = 0;
  const re = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[0].length > longest) longest = m[0].length;
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Parse the JSON output of `claude -p --output-format json`.
 * The shape (per docs):
 *   { result: string, session_id: string, total_cost_usd?: number, ... }
 */
export function parseClaudeCliOutput(stdout: string): ReviewOutput {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('claude -p returned empty stdout');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`claude -p returned non-JSON output: ${trimmed.slice(0, 200)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`claude -p returned non-object JSON: ${trimmed.slice(0, 200)}`);
  }
  const obj = parsed as Record<string, unknown>;
  const result = obj.result;
  if (typeof result !== 'string' || !result) {
    throw new Error(`claude -p response had no "result" string: ${trimmed.slice(0, 200)}`);
  }
  const cost = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined;
  const out: ReviewOutput = { body: result, raw: parsed };
  if (cost !== undefined) out.costUsd = cost;
  return out;
}
