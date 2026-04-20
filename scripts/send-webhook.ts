#!/usr/bin/env bun
/**
 * Sign a fixture payload and POST it to a reviewme /webhook endpoint.
 *
 * Usage:
 *   GITHUB_WEBHOOK_SECRET=... bun scripts/send-webhook.ts <event> <fixture-path> [url]
 *
 * Example:
 *   GITHUB_WEBHOOK_SECRET=test bun scripts/send-webhook.ts ping fixtures/ping.json
 *   GITHUB_WEBHOOK_SECRET=test bun scripts/send-webhook.ts check_suite fixtures/check_suite.completed.json
 */
import { createHmac, randomUUID } from "node:crypto";

const [event, fixturePath, url = "http://127.0.0.1:3000/webhook"] =
  process.argv.slice(2);
const secret = process.env.GITHUB_WEBHOOK_SECRET;

if (!event || !fixturePath || !secret) {
  console.error(
    "Usage: GITHUB_WEBHOOK_SECRET=... bun scripts/send-webhook.ts <event> <fixture-path> [url]",
  );
  process.exit(2);
}

const payload = await Bun.file(fixturePath).text();
const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
const deliveryId = randomUUID();

const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": deliveryId,
    "x-hub-signature-256": signature,
  },
  body: payload,
});

console.log(`→ ${event} (${deliveryId})`);
console.log(`← ${res.status} ${res.statusText}`);
const text = await res.text();
if (text) console.log(text);
process.exit(res.ok ? 0 : 1);
