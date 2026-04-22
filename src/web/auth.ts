import { timingSafeEqual } from "node:crypto";

const REALM = "Auto-Reviewer";

/**
 * Check HTTP Basic auth against a single shared password.
 * Username is fixed to "admin" (the realm has only one principal).
 *
 * Returns null on success. Returns a 401 Response with the appropriate
 * WWW-Authenticate header on failure — the browser will prompt naturally.
 *
 * If `expectedPassword` is empty/unset, auth is disabled and this always
 * returns null. The deployment model is loopback-only by default; enabling
 * a password is the opt-in for VPN/proxy exposure.
 */
export function requireAuth(req: Request, expectedPassword: string): Response | null {
  if (!expectedPassword) return null;

  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return unauthorized();

  let decoded: string;
  try {
    // Browsers encode Basic auth credentials as UTF-8 bytes, then base64. atob()
    // gives back a Latin-1 binary string, which would mangle non-ASCII passwords.
    // Go through Buffer so the round-trip stays UTF-8.
    decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  } catch {
    return unauthorized();
  }

  const sep = decoded.indexOf(":");
  if (sep < 0) return unauthorized();
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  if (!safeEqual("admin", user)) return unauthorized();
  if (!safeEqual(expectedPassword, pass)) return unauthorized();

  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // timingSafeEqual requires equal length; compare a buffer against itself
    // to spend the same work and avoid short-circuiting on length alone.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "www-authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
