import type { Store } from "../state/db.ts";
import type { Runtime } from "./runtime.ts";
import { loadConfigFromStore } from "../config.ts";
import { dashboardRoute } from "./routes/dashboard.ts";
import { reviewDetailRoute } from "./routes/review-detail.ts";
import { eventsRoute } from "./routes/events.ts";
import {
  configRoute,
  handleGeneralPost,
  handleOrgsPost,
  handleReposPost,
} from "./routes/config.ts";
import {
  orgEditRoute,
  handleOrgEditPost,
  handleOrgJiraPost,
  handleOrgLinearPost,
} from "./routes/org-edit.ts";
import { repoEditRoute, handleRepoEditPost } from "./routes/repo-edit.ts";
import { toneTemplateEditRoute, handleToneTemplatePost } from "./routes/tone-template-edit.ts";
import {
  handleDismissFailure,
  handleRecheck,
  handleRetryFailure,
  handleToggleDryRun,
} from "./routes/actions.ts";
import { statusApiRoute } from "./routes/status-api.ts";
import { metricsApiRoute } from "./routes/metrics-api.ts";
import { webhookRoute } from "./routes/webhook.ts";
import { authLoginRoute, authCallbackRoute, authLogoutRoute } from "./routes/auth.ts";
import { usersRoute, handleUserRolePost, handleUserDeletePost } from "./routes/users.ts";
import { hashSessionToken, parseCookies, SESSION_COOKIE_NAME } from "../auth/session.ts";
import { redirect } from "./html.ts";
import { log } from "../log.ts";
import { requireAuth } from "./auth.ts";

export type ServerDeps = {
  store: Store;
  runtime: Runtime;
  host: string;
  port: number;
  password: string;
  /**
   * Shared secret used to verify GitHub webhook signatures. Empty string
   * means webhook ingest is disabled; /webhook/github will respond 503.
   */
  webhookSecret: string;
  /**
   * GitHub OAuth. When both clientId and clientSecret are non-empty,
   * session-based auth takes precedence over basic auth; otherwise the
   * existing basic-auth behavior is unchanged.
   */
  oauthClientId: string;
  oauthClientSecret: string;
};

/**
 * One entry of the route table. `pattern` is either an exact pathname string
 * (fast path, no regex) or a RegExp whose captures are passed to handler via
 * `match`. Handler returns a Response; it may be async.
 */
type Method = "GET" | "POST";
type RouteContext = {
  req: Request;
  url: URL;
  match: RegExpMatchArray | null;
  store: Store;
  runtime: Runtime;
  /** Session user when OAuth is configured AND a valid session exists. Null otherwise. */
  user: { login: string; role: "admin" | "viewer" } | null;
};
type Handler = (ctx: RouteContext) => Response | Promise<Response>;
/**
 * `requireAdmin` marks routes that mutate state. When OAuth is configured,
 * the dispatcher 403s a non-admin user here before the handler runs.
 * When OAuth is NOT configured (basic-auth fallback), the single basic-auth
 * principal is treated as admin.
 */
type Route = {
  method: Method;
  pattern: string | RegExp;
  handler: Handler;
  requireAdmin?: boolean;
};

/**
 * Build the route table. Passed store + runtime here so handlers don't have
 * to thread them through every lambda — they close over the bound values.
 * Tested order: more-specific patterns first when shapes could collide (none
 * do today, but keep it defensive).
 */
function buildRoutes(opts: {
  webhookSecret: string;
  oauth: { clientId: string; clientSecret: string };
}): Route[] {
  const { webhookSecret, oauth } = opts;
  return [
    // Health check is always open (the auth middleware bypasses it too).
    { method: "GET", pattern: "/healthz", handler: () => new Response("ok", { status: 200 }) },

    // Dashboard + JSON status feed.
    {
      method: "GET",
      pattern: "/",
      handler: ({ store, runtime, user }) =>
        dashboardRoute({ store, cfg: loadConfigFromStore(store), runtime, user }),
    },
    {
      method: "GET",
      pattern: "/api/status",
      handler: ({ store, runtime }) => statusApiRoute({ store, runtime }),
    },
    {
      method: "GET",
      pattern: "/api/metrics",
      handler: ({ store, url }) => metricsApiRoute({ store, url }),
    },

    // Config GETs.
    {
      method: "GET",
      pattern: "/config",
      handler: ({ store, user }) =>
        configRoute({
          store,
          cfg: loadConfigFromStore(store),
          webhook: { configured: webhookSecret.length > 0 },
          user,
        }),
    },
    {
      method: "GET",
      pattern: /^\/config\/orgs\/([^/]+)\/edit$/,
      handler: ({ store, match, user }) =>
        orgEditRoute({
          store,
          cfg: loadConfigFromStore(store),
          name: decodeURIComponent(match![1]!),
          user,
        }),
    },
    {
      method: "GET",
      pattern: /^\/config\/repos\/([^/]+)\/([^/]+)\/edit$/,
      handler: ({ store, match, user }) => {
        const slug = `${decodeURIComponent(match![1]!)}/${decodeURIComponent(match![2]!)}`;
        return repoEditRoute({ store, cfg: loadConfigFromStore(store), slug, user });
      },
    },
    {
      method: "GET",
      pattern: "/config/tone-templates/new",
      handler: ({ store, user }) => toneTemplateEditRoute({ store, id: "new", user }),
    },
    {
      method: "GET",
      pattern: /^\/config\/tone-templates\/(\d+)\/edit$/,
      handler: ({ store, match, user }) =>
        toneTemplateEditRoute({ store, id: Number(match![1]), user }),
    },

    // Events.
    { method: "GET", pattern: "/events", handler: ({ store, user }) => eventsRoute({ store, user }) },

    // User management (admin-only).
    {
      method: "GET",
      pattern: "/config/users",
      requireAdmin: true,
      handler: ({ store, user }) =>
        usersRoute({
          store,
          currentLogin: user?.login ?? "",
          currentRole: user?.role ?? "admin",
        }),
    },

    // GitHub OAuth entry points. These are OPEN (no auth required) —
    // that's kind of the point. They're also not admin-gated.
    {
      method: "GET",
      pattern: "/auth/github/login",
      handler: ({ req, url }) => authLoginRoute({ req, url, oauth }),
    },
    {
      method: "GET",
      pattern: "/auth/github/callback",
      handler: ({ req, url, store }) =>
        authCallbackRoute({ req, url, store, oauth }),
    },
    {
      method: "POST",
      pattern: "/auth/logout",
      handler: ({ req, url, store }) => authLogoutRoute({ req, url, store }),
    },

    // Review detail. Placed AFTER /config/* GETs — the three-segment
    // pattern couldn't match any of them, but keeping the order
    // semantically route-specific -> route-specific -> review fallback
    // makes additions safer if anyone ever changes shapes.
    {
      method: "GET",
      pattern: /^\/reviews\/([^/]+)\/([^/]+)\/(\d+)$/,
      handler: ({ store, match, user }) => {
        const owner = decodeURIComponent(match![1]!);
        const name = decodeURIComponent(match![2]!);
        const pr = Number(match![3]);
        return reviewDetailRoute({ store, repo: `${owner}/${name}`, pr, user });
      },
    },

    // Config POSTs — form submissions from the UI. All require admin
    // role when OAuth is configured (viewers get a 403 from the
    // dispatcher). Basic-auth deployments are single-principal so this
    // flag is effectively ignored there.
    {
      method: "POST",
      pattern: "/config/general",
      requireAdmin: true,
      handler: async ({ req, store, user }) => {
        const form = await req.formData();
        const currentCfg = loadConfigFromStore(store);
        const res = await handleGeneralPost(store, form, currentCfg);
        if (!res.ok) {
          // Re-render /config with the submitted candidate + error banner,
          // so the user keeps their edits and sees every field issue at once.
          return configRoute({
            store,
            cfg: res.candidate,
            errors: res.errors,
            webhook: { configured: webhookSecret.length > 0 },
            user,
          });
        }
        return redirect("/config");
      },
    },
    {
      method: "POST",
      pattern: "/config/orgs",
      requireAdmin: true,
      handler: async ({ req, store }) => {
        const form = await req.formData();
        const res = handleOrgsPost(store, form);
        if (!res.ok) return errorPage(res.error);
        return redirect(res.redirect);
      },
    },
    {
      method: "POST",
      pattern: /^\/config\/orgs\/([^/]+)$/,
      requireAdmin: true,
      handler: async ({ req, store, match }) => {
        const form = await req.formData();
        return handleOrgEditPost(store, decodeURIComponent(match![1]!), form);
      },
    },
    {
      method: "POST",
      pattern: /^\/config\/orgs\/([^/]+)\/intent\/jira$/,
      requireAdmin: true,
      handler: async ({ req, store, match }) => {
        const form = await req.formData();
        return handleOrgJiraPost(store, decodeURIComponent(match![1]!), form);
      },
    },
    {
      method: "POST",
      pattern: /^\/config\/orgs\/([^/]+)\/intent\/linear$/,
      requireAdmin: true,
      handler: async ({ req, store, match }) => {
        const form = await req.formData();
        return handleOrgLinearPost(store, decodeURIComponent(match![1]!), form);
      },
    },
    {
      method: "POST",
      pattern: "/config/repos",
      requireAdmin: true,
      handler: async ({ req, store }) => {
        const form = await req.formData();
        const res = handleReposPost(store, form);
        if (!res.ok) return errorPage(res.error);
        return redirect(res.redirect);
      },
    },
    {
      method: "POST",
      pattern: /^\/config\/repos\/([^/]+)\/([^/]+)$/,
      requireAdmin: true,
      handler: async ({ req, store, match }) => {
        const slug = `${decodeURIComponent(match![1]!)}/${decodeURIComponent(match![2]!)}`;
        const form = await req.formData();
        return handleRepoEditPost(store, slug, form);
      },
    },
    {
      method: "POST",
      pattern: "/config/tone-templates",
      requireAdmin: true,
      handler: async ({ req, store }) => {
        const form = await req.formData();
        return handleToneTemplatePost({ store, id: null, form });
      },
    },
    {
      method: "POST",
      pattern: /^\/config\/tone-templates\/(\d+)$/,
      requireAdmin: true,
      handler: async ({ req, store, match }) => {
        const form = await req.formData();
        return handleToneTemplatePost({ store, id: Number(match![1]), form });
      },
    },

    // User management POSTs (admin-only).
    {
      method: "POST",
      pattern: /^\/config\/users\/([^/]+)\/role$/,
      requireAdmin: true,
      handler: async ({ req, store, match, user }) => {
        const form = await req.formData();
        return handleUserRolePost({
          store,
          login: decodeURIComponent(match![1]!),
          currentLogin: user?.login ?? "",
          form,
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/config\/users\/([^/]+)\/delete$/,
      requireAdmin: true,
      handler: ({ store, match, user }) =>
        handleUserDeletePost({
          store,
          login: decodeURIComponent(match![1]!),
          currentLogin: user?.login ?? "",
        }),
    },

    // One-shot actions.
    {
      method: "POST",
      pattern: "/actions/toggle-dry-run",
      requireAdmin: true,
      handler: ({ store }) => handleToggleDryRun(store),
    },
    {
      method: "POST",
      pattern: "/actions/recheck",
      requireAdmin: true,
      handler: async ({ req, store }) => {
        const form = await req.formData();
        return handleRecheck(store, form);
      },
    },
    {
      method: "POST",
      pattern: "/actions/retry-failure",
      requireAdmin: true,
      handler: async ({ req, store }) => {
        const form = await req.formData();
        return handleRetryFailure(store, form);
      },
    },
    {
      method: "POST",
      pattern: "/actions/dismiss-failure",
      requireAdmin: true,
      handler: async ({ req, store }) => {
        const form = await req.formData();
        return handleDismissFailure(store, form);
      },
    },
  ];
}

function matchRoute(routes: Route[], method: string, pathname: string) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (typeof r.pattern === "string") {
      if (r.pattern === pathname) return { route: r, match: null };
    } else {
      const m = pathname.match(r.pattern);
      if (m) return { route: r, match: m };
    }
  }
  return null;
}

export function startWebServer(deps: ServerDeps) {
  const { store, runtime, host, port, password, webhookSecret, oauthClientId, oauthClientSecret } = deps;
  const oauthConfigured = oauthClientId.length > 0 && oauthClientSecret.length > 0;
  const routes = buildRoutes({
    webhookSecret,
    oauth: { clientId: oauthClientId, clientSecret: oauthClientSecret },
  });

  const server = Bun.serve({
    hostname: host,
    port,
    error(err) {
      log.error("web.error", { error: (err as Error).message });
      return new Response("Internal error", { status: 500 });
    },
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();

      // /webhook/github authenticates via HMAC, not session password; and
      // GitHub would never send a same-origin Origin header, so it's also
      // exempt from the CSRF check. Handle it here before the auth guards
      // run so legitimate webhook deliveries aren't rejected by /healthz-
      // style probes.
      if (url.pathname === "/webhook/github" && method === "POST") {
        return await webhookRoute({ req, store, runtime, secret: webhookSecret });
      }

      // Paths that bypass every auth guard entirely. /healthz for proxies
      // and the /auth/github/* OAuth dance which is how un-logged-in users
      // become logged-in users (chicken/egg).
      const isOpenPath =
        url.pathname === "/healthz" ||
        url.pathname.startsWith("/auth/github/");

      // Session resolution. Cheap lookup when OAuth is configured and a
      // cookie is present; no-op when not.
      let user: { login: string; role: "admin" | "viewer" } | null = null;
      if (oauthConfigured) {
        const cookies = parseCookies(req.headers.get("cookie"));
        const raw = cookies[SESSION_COOKIE_NAME];
        if (raw) {
          const session = store.getSession(hashSessionToken(raw));
          if (session) {
            if (new Date(session.expires_at).getTime() <= Date.now()) {
              // Expired. Drop it defensively — next pruneExpiredSessions
              // would do the same, but we want immediate.
              store.deleteSession(session.token_hash);
            } else {
              const u = store.getUser(session.user_login);
              if (u) {
                store.touchSession(session.token_hash);
                user = { login: u.login, role: u.role };
              }
            }
          }
        }
      }

      if (!isOpenPath) {
        if (oauthConfigured) {
          // OAuth mode: require a valid session. Redirect GETs to the
          // login flow; 401 everything else so scripted clients don't
          // silently follow the redirect.
          if (!user) {
            if (method === "GET") {
              return new Response(null, {
                status: 302,
                headers: { location: "/auth/github/login" },
              });
            }
            return new Response("Unauthorized", { status: 401 });
          }
        } else {
          // Basic-auth fallback (single principal, pre-OAuth behavior).
          const unauthorized = requireAuth(req, password);
          if (unauthorized) return unauthorized;
        }
      }

      // Same-origin guard for state-changing requests. Compare Origin against
      // the request's own authority (not the configured bind host) — inside
      // Docker we bind 0.0.0.0 but the browser hits 127.0.0.1, so the old
      // configured-host comparison would 403 every legitimate POST.
      if (method !== "GET" && method !== "HEAD") {
        if (!isSameOrigin(req, url)) {
          return new Response("Cross-origin POST refused", { status: 403 });
        }
      }

      try {
        const hit = matchRoute(routes, method, url.pathname);
        if (!hit) return new Response("Not found", { status: 404 });

        // Admin gate. In OAuth mode viewers get 403 on state-mutating
        // routes; in basic-auth mode the single principal is treated
        // as admin (so the flag is a no-op there).
        if (hit.route.requireAdmin && oauthConfigured && user?.role !== "admin") {
          return new Response("Forbidden: admin role required", {
            status: 403,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }

        return await hit.route.handler({
          req,
          url,
          match: hit.match,
          store,
          runtime,
          user,
        });
      } catch (e) {
        log.error("web.unhandled", { error: (e as Error).message, path: url.pathname });
        return new Response(`Error: ${(e as Error).message}`, { status: 500 });
      }
    },
  });

  log.info("web.listening", { host, port, authEnabled: password.length > 0 });
  return server;
}

function errorPage(msg: string): Response {
  return new Response(`Invalid input: ${msg}`, {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Accept a POST only if the browser-supplied Origin (or Referer) matches the
 * authority the request itself is targeting. Absent Origin/Referer = allow
 * (typical for non-browser clients like curl/Docker healthchecks), which is
 * fine because CSRF requires a browser.
 */
export function isSameOrigin(req: Request, url: URL): boolean {
  const header = req.headers.get("origin") ?? req.headers.get("referer");
  if (!header) return true;
  let claimed: URL;
  try {
    claimed = new URL(header);
  } catch {
    return false;
  }
  return claimed.host === url.host && claimed.protocol === url.protocol;
}
