import type { Store } from "../../state/db.ts";
import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_SECONDS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  constantTimeEqual,
  expiredCookie,
  hashSessionToken,
  mintSessionToken,
  parseCookies,
  sessionCookie,
} from "../../auth/session.ts";
import {
  OAuthError,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchGithubUser,
} from "../../auth/oauth.ts";
import { log } from "../../log.ts";

export type OAuthConfig = {
  clientId: string;
  clientSecret: string;
};

/**
 * GET /auth/github/login — redirect to GitHub's authorize endpoint.
 *
 * We generate a random `state` nonce, set it in a short-lived cookie,
 * and include it in the authorize URL. On callback we compare the
 * returned `state` against the cookie to block CSRF attempts from
 * third-party sites that could otherwise pin a victim to an attacker's
 * GitHub account.
 */
export function authLoginRoute(args: {
  req: Request;
  url: URL;
  oauth: OAuthConfig;
}): Response {
  const { req, url, oauth } = args;
  if (!oauth.clientId || !oauth.clientSecret) {
    return plain(503, "GitHub OAuth is not configured (missing client_id or client_secret)");
  }
  const state = mintSessionToken(); // reuse the 256-bit random helper
  const redirectUri = callbackUrl(req, url);
  const authorizeUrl = buildAuthorizeUrl({
    clientId: oauth.clientId,
    redirectUri,
    state,
  });

  const headers = new Headers();
  headers.append("location", authorizeUrl);
  headers.append(
    "set-cookie",
    sessionCookie({
      name: OAUTH_STATE_COOKIE_NAME,
      value: state,
      maxAgeSeconds: OAUTH_STATE_TTL_SECONDS,
      secure: isHttps(url),
    }),
  );
  return new Response(null, { status: 302, headers });
}

/**
 * GET /auth/github/callback — finalize the OAuth dance.
 *
 *   1. Compare `state` against the cookie (constant-time).
 *   2. Swap `code` for an access token.
 *   3. Fetch the user's login + email.
 *   4. Upsert into users — admin if this is the first login of any user ever.
 *   5. Mint a session token, store hash, set the cookie.
 *   6. Redirect to /.
 */
export async function authCallbackRoute(args: {
  req: Request;
  url: URL;
  store: Store;
  oauth: OAuthConfig;
}): Promise<Response> {
  const { req, url, store, oauth } = args;
  if (!oauth.clientId || !oauth.clientSecret) {
    return plain(503, "GitHub OAuth is not configured");
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !returnedState) {
    return plain(400, "missing code or state on callback");
  }

  const cookies = parseCookies(req.headers.get("cookie"));
  const cookieState = cookies[OAUTH_STATE_COOKIE_NAME];
  if (!cookieState || !constantTimeEqual(cookieState, returnedState)) {
    log.warn("auth.state_mismatch", { hasCookie: Boolean(cookieState) });
    return plain(400, "OAuth state mismatch — refuse to continue login");
  }

  let token: string;
  let gh: { login: string; email: string | null };
  try {
    token = await exchangeCodeForToken({
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      code,
      redirectUri: callbackUrl(req, url),
    });
    gh = await fetchGithubUser(token);
  } catch (e) {
    if (e instanceof OAuthError) {
      log.error("auth.oauth_error", { error: e.message, hint: e.hint });
      store.recordEvent({
        level: "error",
        kind: "auth.oauth_error",
        message: `OAuth login failed: ${e.message}${e.hint ? " — " + e.hint : ""}`,
      });
      return plain(502, `GitHub OAuth failed: ${e.message}`);
    }
    throw e;
  }

  // First-ever successful login → admin. Anyone after → viewer until an
  // existing admin promotes them. This avoids the deadlock where nobody
  // can ever reach the admin UI.
  const isFirstLogin = store.countUsers() === 0;
  const roleIfNew = isFirstLogin ? "admin" : "viewer";
  const inserted = store.upsertUser({ login: gh.login, email: gh.email, roleIfNew });

  const rawToken = mintSessionToken();
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  store.createSession({
    token_hash: tokenHash,
    user_login: gh.login,
    expires_at: expiresAt,
  });
  store.recordEvent({
    level: "info",
    kind: inserted ? "auth.login_first" : "auth.login",
    message: inserted
      ? `${gh.login} signed in for the first time (role=${roleIfNew})`
      : `${gh.login} signed in`,
    payload: { login: gh.login, role: roleIfNew, isFirstLogin },
  });

  const headers = new Headers();
  headers.append("location", "/");
  // Burn the transient state cookie; set the session cookie.
  headers.append("set-cookie", expiredCookie(OAUTH_STATE_COOKIE_NAME, isHttps(url)));
  headers.append(
    "set-cookie",
    sessionCookie({
      name: SESSION_COOKIE_NAME,
      value: rawToken,
      maxAgeSeconds: SESSION_TTL_SECONDS,
      secure: isHttps(url),
    }),
  );
  return new Response(null, { status: 302, headers });
}

/**
 * POST /auth/logout — revoke the session row and clear the cookie.
 */
export function authLogoutRoute(args: {
  req: Request;
  url: URL;
  store: Store;
}): Response {
  const { req, url, store } = args;
  const cookies = parseCookies(req.headers.get("cookie"));
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (rawToken) {
    store.deleteSession(hashSessionToken(rawToken));
  }
  const headers = new Headers();
  headers.append("location", "/auth/github/login");
  headers.append("set-cookie", expiredCookie(SESSION_COOKIE_NAME, isHttps(url)));
  return new Response(null, { status: 302, headers });
}

function callbackUrl(req: Request, url: URL): string {
  // Prefer the X-Forwarded-Proto/Host sent by the reverse proxy (Cloudflare
  // Tunnel, nginx, etc) — otherwise the URL we registered as the callback
  // would drift from the URL the user is actually coming from.
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  return `${proto}://${host}/auth/github/callback`;
}

function isHttps(url: URL): boolean {
  return url.protocol === "https:";
}

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
