// Review runner — stub. Two backends:
//   subscription: spawn `claude -p --output-format json --append-system-prompt …`
//                 with the diff piped on stdin
//   api:          POST to Anthropic API via @anthropic-ai/sdk (added later)
import { config } from '../config.ts';

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
  raw?: unknown;
};

export async function runReview(
  input: ReviewInput,
  mode: 'subscription' | 'api',
): Promise<ReviewOutput> {
  if (mode === 'subscription') {
    return runViaClaudeCli(input);
  }
  return runViaAnthropicApi(input);
}

async function runViaClaudeCli(_input: ReviewInput): Promise<ReviewOutput> {
  // TODO: spawn `${config.claude.bin} -p --output-format json …`
  void config;
  throw new Error('claude -p runner not implemented yet');
}

async function runViaAnthropicApi(_input: ReviewInput): Promise<ReviewOutput> {
  // TODO: Anthropic SDK call
  throw new Error('anthropic api runner not implemented yet');
}
