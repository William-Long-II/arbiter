/**
 * GitHub OAuth helpers for #137.
 *
 * The protocol is straightforward: we send the user to
 * https://github.com/login/oauth/authorize with our client_id + a random
 * `state` nonce, GitHub redirects them back with a `code`, we POST that
 * to /login/oauth/access_token to get an access token, then GET /user
 * for the login + email.
 *
 * URL construction is pure (testable). Code exchange + user fetch use
 * fetch() so the callers can inject a mock in tests if needed.
 */

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

/** Build the authorize URL operators are redirected to on login. */
export function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  /** Space-separated scopes. Default `read:user` is all we need. */
  scope?: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    state: args.state,
    scope: args.scope ?? "read:user",
    allow_signup: "false",
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

/** Thrown by exchangeCodeForToken / fetchGithubUser when the call fails. */
export class OAuthError extends Error {
  readonly hint: string;
  constructor(message: string, hint = "") {
    super(message);
    this.name = "OAuthError";
    this.hint = hint;
  }
}

export type GithubUser = {
  /** Lowercased; GitHub's `login` field with no case-sensitivity guarantees. */
  login: string;
  email: string | null;
};

/**
 * Swap an authorization `code` for an access token. GitHub's /access_token
 * endpoint accepts JSON when you send the right Accept header, which
 * avoids the form-encoded response parsing dance.
 */
export async function exchangeCodeForToken(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<string> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "auto-reviewer",
    },
    body: JSON.stringify({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
  });

  if (!res.ok) {
    throw new OAuthError(
      `token exchange failed: HTTP ${res.status}`,
      "GitHub rejected the code — typically means the OAuth app's client_secret is wrong or the redirect_uri doesn't match the registered callback.",
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new OAuthError(`token exchange returned invalid JSON: ${(e as Error).message}`);
  }

  if (!isObj(body)) throw new OAuthError("token exchange returned a non-object body");
  if (typeof body.error === "string") {
    const desc = typeof body.error_description === "string" ? body.error_description : "";
    throw new OAuthError(`GitHub error: ${body.error}${desc ? ` — ${desc}` : ""}`);
  }
  const token = body.access_token;
  if (typeof token !== "string" || !token) {
    throw new OAuthError("token exchange response missing access_token");
  }
  return token;
}

export async function fetchGithubUser(accessToken: string): Promise<GithubUser> {
  const res = await fetch(GITHUB_USER_URL, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "auto-reviewer",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new OAuthError(
      `user fetch failed: HTTP ${res.status}`,
      "If 401, the token is bad; if 403, the OAuth app may be blocked by the user's org settings.",
    );
  }
  const body = (await res.json()) as { login?: unknown; email?: unknown };
  if (typeof body.login !== "string" || !body.login) {
    throw new OAuthError("user response missing login");
  }
  return {
    login: body.login,
    email: typeof body.email === "string" ? body.email : null,
  };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
