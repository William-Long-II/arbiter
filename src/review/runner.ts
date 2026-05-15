import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import {
  FINDINGS_INSTRUCTION,
  formatUserMessage,
  parseClaudeCliOutput,
  parseFindings,
  parseVerdict,
  type ReviewInput,
  type ReviewOutput,
} from './format.ts';

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
const REVIEW_TIMEOUT_MS = 5 * 60_000;     // 5 minutes
export const MAX_DIFF_BYTES = 1_000_000;  // ~1 MB of unified diff

// Boot-time credential check. A real `claude -p` round-trip is ~5-15s;
// 30s is comfortably above that but far below REVIEW_TIMEOUT_MS, so an
// unauthenticated CLI (which *hangs* rather than erroring) is caught in
// seconds at startup instead of silently burning 5 minutes per review.
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
  let prompt = `${base}\n\n${FINDINGS_INSTRUCTION}\n\n${CONTEXT_PROMPT[context]}`;
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
  if (mode === 'subscription') return runViaClaudeCli(input);
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
    return parseClaudeCliOutput(stdout);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
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
  return { body: f.body, verdict: v.verdict, findings: f.findings, raw: response };
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

  const watchdog = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already exited */ }
  }, PREFLIGHT_TIMEOUT_MS);

  proc.stdin.write('Reply with exactly: OK');
  await proc.stdin.end();

  let exitCode: number;
  let stderr: string;
  try {
    [exitCode, , stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
  } finally {
    clearTimeout(watchdog);
  }

  if (exitCode === 0) return { ok: true, detail: 'claude -p responded' };
  if (proc.killed) {
    return {
      ok: false,
      detail: `claude -p did not respond within ${PREFLIGHT_TIMEOUT_MS}ms — it is hanging, which almost always means the host's Claude credentials are not reachable inside the container`,
    };
  }
  return {
    ok: false,
    detail: `claude -p exited ${exitCode}: ${stderr.trim() || '(no stderr)'}`,
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
