#!/usr/bin/env bun
/**
 * Replay a dead-letter JSON file through the webhook handler.
 *
 * Usage:
 *   bun scripts/replay-dead-letter.ts <path-to-dead-letter.json> [--bypass-signature]
 *
 * Without --bypass-signature the script re-signs the payload with
 * GITHUB_WEBHOOK_SECRET (from the environment) so normal signature
 * verification applies.
 *
 * With --bypass-signature a dummy secret is used when creating the
 * Webhooks instance so the signature is accepted regardless of the
 * stored value.  This is useful for replaying in environments where
 * the original secret is unknown, or in tests.
 *
 * After a successful replay the file is renamed to <path>.replayed so it
 * cannot be accidentally replayed again.  Failed replays leave the file
 * in place — it remains a dead-letter; run the script again or investigate
 * the root cause before retrying.
 */

import { loadAllowlist, loadConfig } from "../src/config";
import { replayOne } from "../src/server/dead-letter-replay";
import { createWebhooks } from "../src/server/webhooks";
import { log } from "../src/server/logger";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const bypassSignature = args.includes("--bypass-signature");
const filePaths = args.filter((a) => !a.startsWith("--"));

if (filePaths.length === 0) {
  console.error(
    "Usage: bun scripts/replay-dead-letter.ts <file> [--bypass-signature]",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const config = loadConfig();
const allowlist = loadAllowlist(config.reposPath);

// When bypassing, use a dummy constant secret so we can sign ourselves.
const effectiveSecret = bypassSignature
  ? "__bypass__"
  : (config.githubWebhookSecret ?? "");

if (!bypassSignature && !config.githubWebhookSecret) {
  log.error("replay: GITHUB_WEBHOOK_SECRET not set and --bypass-signature not given");
  process.exit(1);
}

// Minimal stub deps so the pipeline short-circuits at the allowlist check.
// Callers that want the full pipeline should wire real deps here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubDeps: any = {
  allowlist,
  octokit: {},
  anthropic: {},
  selfLogin: "replay-script",
};

const webhooks = createWebhooks(effectiveSecret, stubDeps);

let exitCode = 0;

for (const filePath of filePaths) {
  log.info("replay: replaying dead letter", { path: filePath, bypassSignature });

  const result = await replayOne(filePath, webhooks, effectiveSecret);
  if (result === "failure") {
    exitCode = 1;
  } else {
    log.info("replay: handler completed without error", { path: filePath });
  }
}

process.exit(exitCode);
