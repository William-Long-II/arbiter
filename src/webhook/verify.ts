import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub webhook signature verification.
 *
 * GitHub sends `X-Hub-Signature-256: sha256=<hex>` computed as HMAC-SHA256 of
 * the raw request body using the shared secret. We recompute the same HMAC
 * and compare in constant time. Rejecting missing / malformed headers is
 * part of the contract — any 401 path here means the caller is not GitHub
 * or the secret is wrong.
 */
export function verifyWebhookSignature(args: {
  body: string;
  secret: string;
  signatureHeader: string | null;
}): boolean {
  const { body, secret, signatureHeader } = args;
  if (!secret) return false;
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith("sha256=")) return false;

  const provided = signatureHeader.slice("sha256=".length).trim();
  // hex-encoded SHA-256 is 64 chars. Wrong length → not worth hashing.
  if (provided.length !== 64) return false;

  const expected = createHmac("sha256", secret).update(body).digest("hex");

  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
