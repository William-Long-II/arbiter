import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../src/webhook/verify.ts";

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

const SECRET = "the-shared-secret";
const BODY = `{"action":"opened","number":42}`;

describe("verifyWebhookSignature", () => {
  test("accepts a correct signature", () => {
    const sig = sign(BODY, SECRET);
    expect(
      verifyWebhookSignature({ body: BODY, secret: SECRET, signatureHeader: sig }),
    ).toBe(true);
  });

  test("rejects a signature computed with the wrong secret", () => {
    const sig = sign(BODY, "a-different-secret");
    expect(
      verifyWebhookSignature({ body: BODY, secret: SECRET, signatureHeader: sig }),
    ).toBe(false);
  });

  test("rejects a signature computed over a different body", () => {
    const sig = sign("different body", SECRET);
    expect(
      verifyWebhookSignature({ body: BODY, secret: SECRET, signatureHeader: sig }),
    ).toBe(false);
  });

  test("rejects missing signature header", () => {
    expect(
      verifyWebhookSignature({ body: BODY, secret: SECRET, signatureHeader: null }),
    ).toBe(false);
  });

  test("rejects missing sha256= prefix", () => {
    const raw = createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(
      verifyWebhookSignature({ body: BODY, secret: SECRET, signatureHeader: raw }),
    ).toBe(false);
  });

  test("rejects when secret is empty (prevents trivial 'sign with empty' bypass)", () => {
    const sig = sign(BODY, "");
    expect(
      verifyWebhookSignature({ body: BODY, secret: "", signatureHeader: sig }),
    ).toBe(false);
  });

  test("rejects signatures of wrong hex length (not 64 chars)", () => {
    expect(
      verifyWebhookSignature({
        body: BODY,
        secret: SECRET,
        signatureHeader: "sha256=abcd",
      }),
    ).toBe(false);
  });

  test("rejects non-hex signature of correct length", () => {
    expect(
      verifyWebhookSignature({
        body: BODY,
        secret: SECRET,
        // Correct length (64 chars) but not valid hex — Buffer.from('hex') drops
        // junk bytes silently, so we rely on the subsequent timingSafeEqual /
        // length comparison to reject.
        signatureHeader: "sha256=" + "z".repeat(64),
      }),
    ).toBe(false);
  });
});
