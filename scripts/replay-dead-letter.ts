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
 */

import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DeadLetterEntry } from "../src/server/dead-letter";
import { loadAllowlist, loadConfig } from "../src/config";
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
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    log.error("replay: failed to read file", {
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    exitCode = 1;
    continue;
  }

  let entry: DeadLetterEntry;
  try {
    entry = JSON.parse(raw) as DeadLetterEntry;
  } catch (err: unknown) {
    log.error("replay: invalid JSON in dead-letter file", {
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    exitCode = 1;
    continue;
  }

  const { delivery_id, event, payload } = entry;

  // Build a fresh signature over the stored payload with the effective secret.
  const freshSignature = `sha256=${createHmac("sha256", effectiveSecret).update(payload).digest("hex")}`;

  log.info("replay: replaying dead letter", {
    path: filePath,
    deliveryId: delivery_id,
    event,
    originalWrittenAt: entry.written_at,
    bypassSignature,
  });

  try {
    await webhooks.verifyAndReceive({
      id: delivery_id,
      name: event as Parameters<typeof webhooks.verifyAndReceive>[0]["name"],
      signature: freshSignature,
      payload,
    });
    log.info("replay: handler completed without error", {
      deliveryId: delivery_id,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Signature mismatches become user errors.
    if (message.includes("signature does not match")) {
      log.error("replay: signature mismatch — use --bypass-signature or set GITHUB_WEBHOOK_SECRET", {
        deliveryId: delivery_id,
      });
    } else {
      // Handler threw — this is expected for events the bot genuinely cannot
      // process; log and continue.
      log.error("replay: handler threw", {
        deliveryId: delivery_id,
        error: message,
      });
    }
    exitCode = 1;
  }
}

process.exit(exitCode);
