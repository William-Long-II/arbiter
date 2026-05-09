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

async function loadScrutinyPrompt(scrutiny: ReviewInput['scrutiny']): Promise<string> {
  return readFile(join(promptsDir, `${scrutiny}.md`), 'utf8');
}

export async function runReview(
  input: ReviewInput,
  mode: 'subscription' | 'api',
): Promise<ReviewOutput> {
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

  // Send the diff + PR meta on stdin so we don't blow up the argv length.
  proc.stdin.write(userMessage);
  await proc.stdin.end();

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  if (exitCode !== 0) {
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
  const response = await client.messages.create({
    model: API_MODEL_BY_SCRUTINY[input.scrutiny],
    max_tokens: MAX_OUTPUT_TOKENS,
    // Cache the system prompt so repeated reviews on the same scrutiny tier
    // hit the prompt cache (cheaper + faster).
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userMessage }],
  });

  const body = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');

  if (!body) {
    throw new Error('Anthropic API returned no text content');
  }

  return { body, raw: response };
}
