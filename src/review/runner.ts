import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';
import {
  formatUserMessage,
  parseClaudeCliOutput,
  type ReviewInput,
  type ReviewOutput,
} from './format.ts';

export type { ReviewInput, ReviewOutput } from './format.ts';

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

export async function runReview(
  input: ReviewInput,
  mode: 'subscription' | 'api',
): Promise<ReviewOutput> {
  assertDiffSize(input.diff);
  if (mode === 'subscription') return runViaClaudeCli(input);
  return runViaAnthropicApi(input);
}

async function runViaClaudeCli(input: ReviewInput): Promise<ReviewOutput> {
  const systemPrompt = await loadScrutinyPrompt(input.scrutiny);
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

  // SIGKILL by the watchdog typically surfaces as a non-zero exit code with
  // no stderr. Distinguish that from a normal failure for clearer logging.
  if (exitCode !== 0) {
    if (proc.killed) throw new ReviewTimeoutError(REVIEW_TIMEOUT_MS);
    throw new Error(
      `claude -p exited with ${exitCode}: ${stderr.trim() || '(no stderr)'}`,
    );
  }
  return parseClaudeCliOutput(stdout);
}

async function runViaAnthropicApi(input: ReviewInput): Promise<ReviewOutput> {
  if (!config.claude.apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured (required for api mode)');
  }
  const systemPrompt = await loadScrutinyPrompt(input.scrutiny);
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

  const body = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');

  if (!body) {
    throw new Error('Anthropic API returned no text content');
  }

  return { body, raw: response };
}
