import { randomBytes, timingSafeEqual, createHash } from "node:crypto";

/**
 * Session primitives for #137.
 *
 * We issue a random 256-bit token on login, store its SHA-256 hash in the
 * sessions table (never the token itself), and set the raw token in a
 * cookie. On each authenticated request we hash the cookie value and
 * look it up. Hashing at rest means a DB snapshot isn't a ticket to
 * impersonate every logged-in user.
 */

export const SESSION_COOKIE_NAME = "ar_session";
export const OAUTH_STATE_COOKIE_NAME = "ar_oauth_state";

/** Default lifetime of a session cookie, in seconds. 14 days. */
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;

/** OAuth state nonce lifetime. 10 minutes is plenty for the round-trip. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** Mint a new session token. 32 bytes = 256 bits of entropy, URL-safe base64. */
export function mintSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of the raw token, hex-encoded. This is what goes in the DB. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Build the Set-Cookie header value for a new or updated session cookie.
 * `secure=true` when the request came in over HTTPS; our loopback-only
 * default deployment is HTTP, so we tolerate both.
 */
export function sessionCookie(args: {
  name: string;
  value: string;
  maxAgeSeconds: number;
  secure: boolean;
  path?: string;
}): string {
  const attrs: string[] = [
    `${args.name}=${args.value}`,
    `Path=${args.path ?? "/"}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${args.maxAgeSeconds}`,
  ];
  if (args.secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Serialize a cookie deletion header — empty value + Max-Age=0. */
export function expiredCookie(name: string, secure: boolean): string {
  return sessionCookie({ name, value: "", maxAgeSeconds: 0, secure });
}

/** Parse the Cookie request header into a flat name→value map. */
export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(value);
  }
  return out;
}

/** Constant-time string compare for OAuth state nonce checks. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
