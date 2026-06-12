import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import {
  FINDINGS_INSTRUCTION,
  ITEMS_INSTRUCTION,
  PROCESS_GUARD,
  formatUserMessage,
  parseClaudeCliOutput,
  parseFindingItems,
  parseFindings,
  parseVerdict,
  stripSkillMetaPreamble,
  type ReviewInput,
  type ReviewOutput,
} from './format.ts';
import { INJECTION_GUARD } from './injection.ts';

export type { ReviewInput, ReviewOutput, Verdict } from './format.ts';

const here = dirname(fileURLToPath(import.meta.url));
const promptsDir = join(here, 'prompts');

// Per-scrutiny model when calling the Anthropic API directly. Subscription
// mode lets `claude -p` pick the model bound to the user's session.
const API_MODEL_BY_SCRUTINY = {
  light: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-4-6',
  strict: 'claude-opus-4-7',
} as const;

const MAX_OUTPUT_TOKENS = 4096;

// Hard caps to protect the worker (and your subscription quota / API
// budget) from runaway inputs and stuck subprocesses.
const REVIEW_TIMEOUT_MS = config.reviewTimeoutSeconds * 1000;  // default 15 min, REVIEW_TIMEOUT_SECONDS
export const MAX_DIFF_BYTES = 1_000_000;  // ~1 MB of unified diff

// Boot-time credential check. A real `claude -p` round-trip is ~5-15s;
// 30s is comfortably above that but far below REVIEW_TIMEOUT_MS, so an
// unauthenticated CLI (which *hangs* rather than erroring) is caught in
// seconds at startup instead of silently burning the full review window.
const PREFLIGHT_TIMEOUT_MS = 30_000;
// Each git step in a 'checkout'-context review is bounded so a slow or
// huge repo can't eat the whole review window. Exceeding it falls back
// to an isolated (diff-only) review rather than failing.
const CHECKOUT_STEP_TIMEOUT_MS = 90_000;

export class DiffTooLargeError extends Error {
  constructor(public readonly bytes: number, public readonly limit: number) {
    super(`Diff is ${bytes} bytes; limit is ${limit}. Skipping review.`);
    this.name = 'DiffTooLargeError';
  }
}

export class ReviewTimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`Review did not complete within ${ms}ms.`);
    this.name = 'ReviewTimeoutError';
  }
}

function assertDiffSize(diff: string): void {
  const bytes = Buffer.byteLength(diff, 'utf8');
  if (bytes > MAX_DIFF_BYTES) {
    throw new DiffTooLargeError(bytes, MAX_DIFF_BYTES);
  }
}

async function loadScrutinyPrompt(scrutiny: ReviewInput['scrutiny']): Promise<string> {
  return readFile(join(promptsDir, `${scrutiny}.md`), 'utf8');
}

export const CONTEXT_PROMPT: Record<'isolated' | 'checkout', string> = {
  isolated:
    '## Review context\n\n' +
    'You are reviewing from the unified diff in the user message ONLY. ' +
    'There is no repository checkout or working tree, and your working ' +
    'directory is intentionally empty. Do not attempt to read files, list ' +
    'directories, or inspect a working directory — nothing relevant is ' +
    'there. Do NOT add caveats about being unable to verify cross-module ' +
    'references, missing files, or the working directory containing an ' +
    'unrelated project. Review strictly what the diff shows, with the ' +
    'confidence the diff supports.',
  checkout:
    '## Review context\n\n' +
    "The pull request's repository is checked out at its head commit in " +
    'your current working directory. You may read files there to verify ' +
    'cross-module references, confirm symbols exist, and understand ' +
    'surrounding code. Keep the review focused on the changes in the ' +
    'provided diff; use the checkout to verify and add precision, not to ' +
    'review unrelated code.',
};

/**
 * Concatenate the scrutiny base prompt + a review-context note + the
 * scope's optional personality. Both additions are additive (don't
 * replace) so the scrutiny tier's output-format rules (verdict marker,
 * blocking-issues structure) still apply. `context` is the *effective*
 * context — it reflects a checkout that actually succeeded, so the model
 * is never told it has a working tree it doesn't.
 */
async function buildSystemPrompt(
  input: ReviewInput,
  context: 'isolated' | 'checkout',
): Promise<string> {
  const base = await loadScrutinyPrompt(input.scrutiny);
  let prompt =
    `${base}\n\n${FINDINGS_INSTRUCTION}\n\n${ITEMS_INSTRUCTION}\n\n` +
    `${CONTEXT_PROMPT[context]}\n\n${INJECTION_GUARD}\n\n${PROCESS_GUARD}`;
  const personality = input.personalityPrompt?.trim();
  if (personality) {
    prompt += `\n\n## Additional reviewer guidance for this scope\n\n${personality}`;
  }
  return prompt;
}

/**
 * Shallow-checkout the PR head into `dir`. Returns true on success. The
 * token is passed via http.extraheader (not the remote URL) so it never
 * lands in .git/config or the reflog; the dir is removed after the review
 * regardless. Each git step is time-bounded. Any failure returns false —
 * the caller degrades to an isolated, diff-only review instead of failing.
 */
async function checkoutPrHead(
  dir: string,
  repoFull: string,
  prNumber: number,
  token: string,
): Promise<boolean> {
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) return false;
  const auth =
    'AUTHORIZATION: basic ' +
    Buffer.from(`x-access-token:${token}`).toString('base64');
  const steps: string[][] = [
    ['git', 'init', '-q'],
    ['git', 'remote', 'add', 'origin', `https://github.com/${owner}/${repo}.git`],
    [
      'git', '-c', `http.extraheader=${auth}`,
      'fetch', '-q', '--depth', '1', 'origin', `pull/${prNumber}/head`,
    ],
    ['git', 'checkout', '-q', 'FETCH_HEAD'],
  ];
  for (const cmd of steps) {
    try {
      const p = Bun.spawn({
        cmd,
        cwd: dir,
        stdout: 'ignore',
        stderr: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      const killer = setTimeout(() => {
        try { p.kill('SIGKILL'); } catch { /* already exited */ }
      }, CHECKOUT_STEP_TIMEOUT_MS);
      let code: number;
      try {
        code = await p.exited;
      } finally {
        clearTimeout(killer);
      }
      if (code !== 0) {
        const why = (await new Response(p.stderr).text()).trim();
        console.error(
          `[runner] checkout step ${cmd.join(' ').replace(auth, '[redacted]')} ` +
            `failed (${code}) for ${repoFull}#${prNumber}: ${why || '(no stderr)'}`,
        );
        return false;
      }
    } catch (err) {
      // Bun.spawn throws synchronously if `git` isn't on PATH (e.g. an
      // image built before git was added). Treat as a failed checkout so
      // the caller degrades to an isolated review instead of failing.
      console.error(
        `[runner] checkout step ${cmd[0]} could not run for ` +
          `${repoFull}#${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
  return true;
}

export async function runReview(
  input: ReviewInput,
  mode: 'subscription' | 'api',
): Promise<ReviewOutput> {
  assertDiffSize(input.diff);
  const out = await runReviewCore(input, mode);
  // Opt-in second pass: when the scope set both personality and humanize,
  // rewrite the parsed prose body in that voice. parseClaudeCliOutput and
  // the API-mode parser have already stripped verdict/findings/items
  // markers from `body`, so the rewrite is pure prose — no marker
  // preservation needed and verdict/items pass through unchanged.
  const personality = input.personalityPrompt?.trim();
  if (input.humanize && personality && out.body.trim()) {
    try {
      const rewritten = await humanizeBody(out.body, personality, mode);
      out.body = rewritten.body;
      if (rewritten.costUsd !== undefined) {
        out.costUsd = (out.costUsd ?? 0) + rewritten.costUsd;
      }
      out.prompts = [
        ...(out.prompts ?? []),
        { label: 'humanize', prompt: rewritten.systemPrompt },
      ];
    } catch (err) {
      // Humanize must never break the review — fall back to the original
      // body and log. The skill/built-in pass already produced something
      // valid; losing the rewrite is strictly better than losing the row.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[runner] humanize pass failed, keeping original body: ${msg}`);
    }
  }
  return out;
}

async function runReviewCore(
  input: ReviewInput,
  mode: 'subscription' | 'api',
): Promise<ReviewOutput> {
  if (mode === 'subscription') {
    // Skills only work through the CLI (the SDK has no skill surface), so
    // API mode silently falls back to the built-in prompt regardless of
    // reviewerSkill — the choice is recorded on the row either way.
    const skill = input.reviewerSkill?.trim();
    if (skill) return runViaSkillCli(input, skill);
    return runViaClaudeCli(input);
  }
  return runViaAnthropicApi(input);
}

async function runViaClaudeCli(input: ReviewInput): Promise<ReviewOutput> {
  // Always run in a fresh temp dir so the subprocess never inherits the
  // container's /app cwd (arbiter's own source) — that was the cause of
  // "the working directory contains an unrelated project" caveats and
  // wasted filesystem exploration. For 'checkout' context we populate it
  // with the PR head; otherwise it stays empty (diff-only review).
  const workDir = await mkdtemp(join(tmpdir(), 'arbiter-review-'));
  try {
    let effectiveContext: 'isolated' | 'checkout' = 'isolated';
    if (input.reviewContext === 'checkout' && input.checkout) {
      const ok = await checkoutPrHead(
        workDir,
        input.repoFull,
        input.checkout.prNumber,
        input.checkout.token,
      );
      if (ok) {
        effectiveContext = 'checkout';
      } else {
        console.error(
          `[runner] ${input.repoFull}#${input.checkout.prNumber}: checkout ` +
            `failed; falling back to isolated diff-only review`,
        );
      }
    }

    const systemPrompt = await buildSystemPrompt(input, effectiveContext);
    const userMessage = formatUserMessage(input);

    const proc = Bun.spawn({
      cmd: [
        config.claude.bin,
        '-p',
        '--output-format',
        'json',
        '--append-system-prompt',
        systemPrompt,
      ],
      cwd: workDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Watchdog: if the subprocess hasn't exited within REVIEW_TIMEOUT_MS,
    // SIGKILL it so the request doesn't hang forever (e.g. on a stalled
    // session or bad credentials).
    const watchdog = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already exited */ }
    }, REVIEW_TIMEOUT_MS);

    // Send the diff + PR meta on stdin so we don't blow up the argv length.
    proc.stdin.write(userMessage);
    await proc.stdin.end();

    let exitCode: number;
    let stdout: string;
    let stderr: string;
    try {
      [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
    } finally {
      clearTimeout(watchdog);
    }

    // SIGKILL by the watchdog typically surfaces as a non-zero exit code
    // with no stderr. Distinguish that from a normal failure for clearer
    // logging.
    if (exitCode !== 0) {
      if (proc.killed) throw new ReviewTimeoutError(REVIEW_TIMEOUT_MS);
      throw new Error(
        `claude -p exited with ${exitCode}: ${stderr.trim() || '(no stderr)'}`,
      );
    }
    const out = parseClaudeCliOutput(stdout);
    out.prompts = [{ label: 'built-in', prompt: systemPrompt }];
    return out;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Skill-driven review path. Spawns `claude -p` with a wrapper system
 * prompt that triggers the named Claude Code skill against the diff
 * supplied on stdin, pre-supplying the answers the skill would otherwise
 * HALT to ask (review target, no spec, do not pause). The wrapper also
 * pins arbiter's output contract (verdict + findings markers, optional
 * located items) so the skill's output still parses through
 * parseClaudeCliOutput unchanged.
 *
 * The skill must be reachable from the worker's home directory
 * (~/.claude/skills/<name>/ or via an installed plugin). If the skill is
 * missing the CLI just won't invoke it and we'll get a degraded review —
 * the prompt tells the model to review silently anyway (PROCESS_GUARD),
 * and stripSkillMetaPreamble scrubs + logs it if the model narrates the
 * fallback into the body regardless. If the CLI errors, that surfaces as
 * the existing non-zero-exit error with stderr.
 */
async function runViaSkillCli(
  input: ReviewInput,
  skillName: string,
): Promise<ReviewOutput> {
  const workDir = await mkdtemp(join(tmpdir(), 'arbiter-review-'));
  try {
    let effectiveContext: 'isolated' | 'checkout' = 'isolated';
    if (input.reviewContext === 'checkout' && input.checkout) {
      const ok = await checkoutPrHead(
        workDir,
        input.repoFull,
        input.checkout.prNumber,
        input.checkout.token,
      );
      if (ok) effectiveContext = 'checkout';
    }

    const systemPrompt = buildSkillSystemPrompt(
      skillName,
      effectiveContext,
      input.personalityPrompt,
    );
    const userMessage = formatUserMessage(input);

    const proc = Bun.spawn({
      cmd: [
        config.claude.bin,
        '-p',
        '--output-format',
        'json',
        '--append-system-prompt',
        systemPrompt,
      ],
      cwd: workDir,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const watchdog = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already exited */ }
    }, REVIEW_TIMEOUT_MS);

    proc.stdin.write(userMessage);
    await proc.stdin.end();

    let exitCode: number;
    let stdout: string;
    let stderr: string;
    try {
      [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
    } finally {
      clearTimeout(watchdog);
    }

    if (exitCode !== 0) {
      if (proc.killed) throw new ReviewTimeoutError(REVIEW_TIMEOUT_MS);
      throw new Error(
        `claude -p (skill=${skillName}) exited with ${exitCode}: ` +
          `${stderr.trim() || '(no stderr)'}`,
      );
    }
    const out = parseClaudeCliOutput(stdout);
    // Known degraded-mode leak: the skill isn't installed in the worker
    // and the model narrates the fallback into the posted body. The
    // prompt forbids it (PROCESS_GUARD); this catches it anyway, and the
    // log tells the operator the worker image is missing the skill.
    const swept = stripSkillMetaPreamble(out.body, skillName);
    if (swept.stripped !== null) {
      console.error(
        `[runner] skill review leaked process meta-commentary ` +
          `(skill=${skillName}, likely not installed in worker); ` +
          `stripped: ${swept.stripped.slice(0, 200)}`,
      );
      out.body = swept.body;
    }
    out.prompts = [{ label: `skill:${skillName}`, prompt: systemPrompt }];
    return out;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Wrapper system prompt for skill-driven reviews. Pre-supplies the
 * context that interactive skills (like bmad-code-review) would HALT to
 * gather, then re-asserts arbiter's machine-readable output contract so
 * whatever the skill produces still has the verdict + findings markers
 * parseClaudeCliOutput expects.
 *
 * `personalityPrompt` is appended as additional guidance — best-effort
 * only: rigid skills often drown out an in-prompt voice instruction,
 * which is why scopes can additionally opt into the post-parse humanize
 * pass (see humanizeBody).
 */
export function buildSkillSystemPrompt(
  skillName: string,
  context: 'isolated' | 'checkout',
  personalityPrompt?: string | null,
): string {
  const sections = [
    `You will review the pull request in the user message by running the`,
    `Claude Code skill \`/${skillName}\`.`,
    ``,
    `Pre-supplied context for that skill (do NOT halt to ask for any of it):`,
    `- Review target: the unified diff included in the user message.`,
    `- Diff source: provided diff (do not run git to fetch a different one).`,
    `- Spec: none. Run in no-spec mode if the skill supports it.`,
    `- Do NOT pause or wait for user confirmation at any checkpoint —`,
    `  proceed all the way through to the combined final review.`,
    `- If \`/${skillName}\` is not installed or fails to load, perform a`,
    `  review of equivalent rigor yourself, and never mention the skill or`,
    `  its absence in your output.`,
    ``,
    CONTEXT_PROMPT[context],
    ``,
    `## Output contract — REQUIRED regardless of the skill's native format`,
    ``,
    `After the skill finishes, your final response (the body that will be`,
    `posted to GitHub) MUST start with arbiter's machine-readable markers:`,
    ``,
    FINDINGS_INSTRUCTION,
    ``,
    ITEMS_INSTRUCTION,
    ``,
    INJECTION_GUARD,
    ``,
    PROCESS_GUARD,
  ];
  const personality = personalityPrompt?.trim();
  if (personality) {
    sections.push(
      ``,
      `## Additional reviewer guidance for this scope`,
      ``,
      personality,
    );
  }
  return sections.join('\n');
}

/**
 * System prompt for the humanize rewrite pass. The user message is the
 * already-parsed review body (verdict/findings/items markers stripped),
 * so we can be unambiguous: rewrite the prose, change nothing else.
 *
 * Why this prompt is shaped the way it is: a previous version told the
 * model to preserve overall structure. That preserved exactly the
 * structural AI tells (Major/Minor/Nit headers, bolded lead-ins on every
 * bullet, "Things I checked that are fine" closers) that made the output
 * still read as AI even after the prose was reworked. The fix is to
 * lock substance hard and explicitly permit — encourage — restructuring,
 * cutting comprehensiveness, and uneven depth.
 */
export function buildHumanizeSystemPrompt(personalityPrompt: string): string {
  return [
    'You are rewriting a Markdown code review so it reads like a real',
    'engineer typed it during work, not a polished AI report. Match the',
    'voice under "## Voice" below, and follow these defaults regardless',
    'of voice.',
    '',
    '## Substance is locked',
    '',
    '- Keep every finding, claim, code reference, file path, line number,',
    '  link, code fence, and HTML comment exactly as-is.',
    '- Do NOT add new findings, remove existing ones, or change their',
    '  severity. Do not soften or sharpen the technical conclusion.',
    '',
    '## You MAY restructure',
    '',
    'The input is often laid out like a template — severity headers,',
    'bolded lead-ins on every bullet, a closing enumeration of things',
    'that look fine. Real reviewers do not write that way. You are',
    'allowed and encouraged to:',
    '',
    '- Drop categorization headers like "### Major / ### Minor / ### Nit".',
    '  Tag a small thing inline with "nit:" if it needs marking at all.',
    '- Collapse bulleted findings with bolded lead-ins into prose. Most',
    '  findings should read as a paragraph, not a labeled bullet.',
    '- Drop any "Things I checked that are fine" / "Things that look',
    '  good" enumeration. Engineers do not list what they approved.',
    '- Let depth be uneven. One finding can get a paragraph; another can',
    '  be one sentence. Cut findings that genuinely do not matter rather',
    '  than mention-and-dismiss them (but keep every substantive one).',
    '',
    'Target ~50–70% of the input length.',
    '',
    '## Patterns to imitate',
    '',
    '- Lead with reaction, not summary. No throat-clearing intro paragraph.',
    '- Ask real questions ("wait, where does `capitalize` live now?")',
    '  rather than rhetorical ones ("I would like to confirm before',
    '  merging — can you point me to…").',
    '- First person without ceremony: "I think", "I would skip this".',
    '- Inline "nit:" is fine. So is "lgtm except X".',
    '- Fragments and lowercase starts are OK where they sound natural.',
    '',
    '## Patterns to avoid (the AI tells)',
    '',
    '- Bolded lead-ins on every bullet (`**A bunch of functions...**`).',
    '  Just write the sentence.',
    '- Major / Minor / Nit severity headers.',
    '- "Things I checked / things that are fine" sections.',
    '- Em-dashes — use sparingly, one or two in the whole review at most.',
    '- Calibrated hedge phrases: "worth a", "low priority",',
    '  "non-blocking", "arguably", "not test-worthy unless".',
    '- Evenly-paced thoroughness. Vary depth deliberately.',
    '',
    '## Output',
    '',
    'Output ONLY the rewritten review — no "Here is the rewritten…"',
    'preamble, no fences wrapping the whole thing, no sign-off.',
    '',
    '## Voice',
    '',
    personalityPrompt,
  ].join('\n');
}

interface HumanizeResult {
  body: string;
  costUsd?: number;
  systemPrompt: string;
}

/**
 * Run the rewrite pass. Picks the same transport as the originating
 * review (subscription → `claude -p`; api → Anthropic SDK with haiku)
 * so a humanize call doesn't quietly start charging api when the review
 * is on subscription. Bounded by REVIEW_TIMEOUT_MS — a stuck rewrite
 * must not eat the whole queue.
 */
async function humanizeBody(
  body: string,
  personalityPrompt: string,
  mode: 'subscription' | 'api',
): Promise<HumanizeResult> {
  const systemPrompt = buildHumanizeSystemPrompt(personalityPrompt);

  if (mode === 'subscription') {
    const proc = Bun.spawn({
      cmd: [
        config.claude.bin,
        '-p',
        '--output-format',
        'json',
        '--append-system-prompt',
        systemPrompt,
      ],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const watchdog = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already exited */ }
    }, REVIEW_TIMEOUT_MS);
    proc.stdin.write(body);
    await proc.stdin.end();
    let exitCode: number;
    let stdout: string;
    let stderr: string;
    try {
      [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
    } finally {
      clearTimeout(watchdog);
    }
    if (exitCode !== 0) {
      if (proc.killed) throw new ReviewTimeoutError(REVIEW_TIMEOUT_MS);
      throw new Error(
        `humanize claude -p exited with ${exitCode}: ${stderr.trim() || '(no stderr)'}`,
      );
    }
    // Reuse parseClaudeCliOutput to pluck `result` + `total_cost_usd`.
    // The verdict/findings parses inside it are harmless — the rewrite
    // shouldn't emit those markers, so they'll just no-op and we keep
    // the call site's verdict/findings/items untouched.
    const parsed = parseClaudeCliOutput(stdout);
    const text = parsed.body.trim();
    if (!text) throw new Error('humanize claude -p returned empty body');
    return { body: text, costUsd: parsed.costUsd, systemPrompt };
  }

  if (!config.claude.apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured (required for api mode)');
  }
  const client = new Anthropic({ apiKey: config.claude.apiKey });
  // Haiku for the rewrite regardless of the review's scrutiny tier —
  // it's a prose transform, not a fresh judgment, and we don't want a
  // Sonnet/Opus humanize bill on top of a Sonnet/Opus review.
  let response;
  try {
    response = await client.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: body }],
      },
      { signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS) },
    );
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new ReviewTimeoutError(REVIEW_TIMEOUT_MS);
    }
    throw err;
  }
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
  if (!text) throw new Error('humanize Anthropic API returned no text');
  return { body: text, systemPrompt };
}

async function runViaAnthropicApi(input: ReviewInput): Promise<ReviewOutput> {
  if (!config.claude.apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured (required for api mode)');
  }
  // API mode has no tools/filesystem, so it is always diff-only — use the
  // isolated wording regardless of the scope's review context.
  const systemPrompt = await buildSystemPrompt(input, 'isolated');
  const userMessage = formatUserMessage(input);

  const client = new Anthropic({ apiKey: config.claude.apiKey });
  let response;
  try {
    response = await client.messages.create(
      {
        model: API_MODEL_BY_SCRUTINY[input.scrutiny],
        max_tokens: MAX_OUTPUT_TOKENS,
        // Cache the system prompt so repeated reviews on the same scrutiny
        // tier hit the prompt cache (cheaper + faster).
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: userMessage }],
      },
      { signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS) },
    );
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new ReviewTimeoutError(REVIEW_TIMEOUT_MS);
    }
    throw err;
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');

  if (!text) {
    throw new Error('Anthropic API returned no text content');
  }

  const v = parseVerdict(text);
  const f = parseFindings(v.body);
  const i = parseFindingItems(f.body);
  return {
    body: i.body,
    verdict: v.verdict,
    findings: f.findings,
    items: i.items,
    prompts: [{ label: 'built-in', prompt: systemPrompt }],
    raw: response,
  };
}

export interface PreflightResult {
  ok: boolean;
  /** Human-readable reason, surfaced verbatim in the boot error. */
  detail: string;
}

/**
 * Subscription-mode credential health check. Spawns `claude -p` with a
 * trivial prompt and a short timeout. The three failure shapes map to
 * the three real-world causes:
 *   - spawn throws        → binary not on PATH (CLAUDE_BIN wrong/missing)
 *   - watchdog SIGKILL    → CLI hung waiting on a login it can't do
 *                           non-interactively → credentials not reachable
 *   - non-zero exit       → CLI ran but rejected (expired/invalid creds);
 *                           stderr usually says which
 */
export async function preflightClaudeCli(): Promise<PreflightResult> {
  // Explicit pipe type params so stdin/stdout narrow to FileSink /
  // ReadableStream (a bare ReturnType<typeof Bun.spawn> stays the broad
  // union and loses .write/.end and Response() compatibility).
  let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn({
      cmd: [config.claude.bin, '-p', '--output-format', 'json'],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: `could not spawn '${config.claude.bin}' (${message}) — claude binary not found on PATH (check CLAUDE_BIN)`,
    };
  }

  // Track timeout via an explicit flag rather than `proc.killed`. Bun
  // sets `proc.killed = true` on non-zero exits even when nothing called
  // proc.kill() (observed with `claude -p` returning a 401 JSON in ~2s),
  // so reading `proc.killed` here misattributes fast auth failures as
  // 30-second hangs.
  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    try { proc.kill('SIGKILL'); } catch { /* already exited */ }
  }, PREFLIGHT_TIMEOUT_MS);

  proc.stdin.write('Reply with exactly: OK');
  await proc.stdin.end();

  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
  } finally {
    clearTimeout(watchdog);
  }

  return classifyPreflight({ exitCode, timedOut, stdout, stderr });
}

/**
 * Pure classifier for {@link preflightClaudeCli} so the decision logic
 * can be unit-tested without spawning a real `claude` subprocess.
 *
 * `claude -p --output-format json` writes its structured failure to
 * stdout (e.g. `{"result":"Failed to authenticate. API Error: 401 ..."}`)
 * and leaves stderr empty, so we prefer stdout when surfacing the cause.
 */
export function classifyPreflight(args: {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): PreflightResult {
  if (args.exitCode === 0) return { ok: true, detail: 'claude -p responded' };
  if (args.timedOut) {
    return {
      ok: false,
      detail: `claude -p did not respond within ${PREFLIGHT_TIMEOUT_MS}ms — it is hanging, which almost always means the host's Claude credentials are not reachable inside the container`,
    };
  }
  const detail = args.stdout.trim() || args.stderr.trim() || '(no output)';
  return {
    ok: false,
    detail: `claude -p exited ${args.exitCode}: ${detail}`,
  };
}

/**
 * The boot-time error message. It IS the setup doc — the container runs
 * Linux and can't know the host OS, so it spells out all three host
 * cases. Kept pure (no I/O) so it can be unit-tested.
 */
export function formatSubscriptionPreflightError(detail: string): string {
  return [
    '',
    '  ┌─ SUBSCRIPTION CREDENTIALS NOT REACHABLE ─────────────────────────',
    '  │',
    `  │  ${detail}`,
    '  │',
    '  │  In subscription mode the container shells out to `claude -p`,',
    '  │  which needs the host\'s Claude Code credentials bind-mounted at',
    '  │  /root/.claude. Fix this on the HOST:',
    '  │',
    '  │  0. Be logged in: run `claude` once on the host and sign in.',
    '  │  • Linux:   ~/.claude/.credentials.json must exist; the default',
    '  │             mount then works with no extra config.',
    '  │  • Windows: $HOME is unset under PowerShell, so the mount falls',
    '  │             back to an empty dir. Set CLAUDE_HOST_DIR in .env to',
    '  │             your creds dir, e.g. C:/Users/<you>/.claude',
    '  │  • macOS:   creds live in the Keychain, not a file. Export them:',
    '  │               mkdir -p ~/.claude',
    '  │               security find-generic-password \\',
    '  │                 -s \'Claude Code-credentials\' -w \\',
    '  │                 > ~/.claude/.credentials.json',
    '  │               chmod 600 ~/.claude/.credentials.json',
    '  │',
    '  │  Easiest: run `bun run setup` on the host — it does the OS-',
    '  │  specific wiring for you. Then:',
    '  │    docker compose up -d --force-recreate app',
    '  │',
    '  │  Or switch to API mode: set CLAUDE_DEFAULT_MODE=api and',
    '  │  ANTHROPIC_API_KEY. See README → "Subscription mode in Docker".',
    '  └──────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');
}
