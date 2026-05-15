// Pure helpers for the review runner — kept separate so they can be unit-
// tested without mocking Bun.spawn or Anthropic SDK.

export type ReviewInput = {
  scrutiny: 'light' | 'standard' | 'strict';
  diff: string;
  prTitle: string;
  prAuthor: string;
  repoFull: string;
  /** Optional free-text guidance appended to the scrutiny system prompt.
   * Carried through from scope.personalityPrompt at enqueue time. */
  personalityPrompt?: string | null;
  /** Pre-formatted CI summary (Markdown block) sourced from the GitHub
   * checks + statuses APIs. Null/undefined when the repo has no signals
   * — in that case the prompt omits the section entirely. */
  ciSummary?: string | null;
  /** Coverage caveat for reconstructed large-PR diffs (set by
   * fetchPullRequest's listFiles fallback). When present, the diff is
   * partial and the model is told to open with a visible caveat. Null for
   * normal full diffs. */
  diffNotice?: string | null;
  /** Advisory reviewer guidance derived from the changed-file set
   * (sensitive-path scrutiny escalation, test-gap). Rendered as a callout
   * just before the diff. Null/undefined when no signal fired. */
  signalsNote?: string | null;
  /** What the reviewer subprocess sees. 'isolated' (default): diff only,
   * empty working dir. 'checkout': PR head checked out so cross-module
   * refs can be verified. Snapshotted from scope at enqueue. */
  reviewContext?: 'isolated' | 'checkout';
  /** Only consulted when reviewContext === 'checkout' (CLI mode). The
   * token + PR ref needed to shallow-checkout the PR head. */
  checkout?: { token: string; prNumber: number; headSha: string } | null;
};

export type Verdict = 'approve' | 'comment' | 'request-changes';

export type ReviewOutput = {
  /** Body to post to GitHub, with the verdict marker stripped. */
  body: string;
  /** Parsed from the verdict marker; defaults to `comment` if absent. */
  verdict: Verdict;
  costUsd?: number;
  /** Raw underlying response for debugging — not persisted. */
  raw?: unknown;
};

/**
 * Pull the verdict marker off the leading whitespace of `body` and return
 * the verdict + the body with the marker removed. We instruct the model
 * to emit `<!-- arbiter:verdict=approve|comment|request-changes -->` as
 * the first line of its response. If it forgets, default to `comment` —
 * the safe fallback that only posts as a regular review comment.
 */
const VERDICT_RE =
  /<!--\s*arbiter:verdict=(approve|comment|request-changes)\s*-->/i;

export function parseVerdict(body: string): { verdict: Verdict; body: string } {
  const match = body.match(VERDICT_RE);
  if (!match) return { verdict: 'comment', body };
  const verdict = match[1]!.toLowerCase() as Verdict;
  const stripped = body.replace(match[0], '').replace(/^\s+/, '');
  return { verdict, body: stripped };
}

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
  const lines: string[] = [
    `Please review the following pull request.`,
    ``,
    `Repository: ${input.repoFull}`,
    `PR title: ${input.prTitle}`,
    `Author: ${input.prAuthor}`,
    `Scrutiny tier: ${input.scrutiny}`,
  ];
  if (input.ciSummary && input.ciSummary.trim().length > 0) {
    lines.push(``, input.ciSummary);
  }
  if (input.diffNotice && input.diffNotice.trim().length > 0) {
    lines.push(
      ``,
      `> [!IMPORTANT] Large pull request — partial diff`,
      `> ${input.diffNotice.trim()}`,
    );
  }
  if (input.signalsNote && input.signalsNote.trim().length > 0) {
    lines.push(``, `> [!NOTE] ${input.signalsNote.trim()}`);
  }
  lines.push(``, `Unified diff:`, `${fence}diff`, input.diff, fence);
  return lines.join('\n');
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
  const { verdict, body } = parseVerdict(result);
  const out: ReviewOutput = { body, verdict, raw: parsed };
  if (cost !== undefined) out.costUsd = cost;
  return out;
}
