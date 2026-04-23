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
import { orgEditRoute, handleOrgEditPost } from "./routes/org-edit.ts";
import { repoEditRoute, handleRepoEditPost } from "./routes/repo-edit.ts";
import { handleRecheck, handleToggleDryRun } from "./routes/actions.ts";
import { statusApiRoute } from "./routes/status-api.ts";
import { redirect } from "./html.ts";
import { log } from "../log.ts";
import { requireAuth } from "./auth.ts";

export type ServerDeps = {
  store: Store;
  runtime: Runtime;
  host: string;
  port: number;
  password: string;
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
};
type Handler = (ctx: RouteContext) => Response | Promise<Response>;
type Route = { method: Method; pattern: string | RegExp; handler: Handler };

/**
 * Build the route table. Passed store + runtime here so handlers don't have
 * to thread them through every lambda — they close over the bound values.
 * Tested order: more-specific patterns first when shapes could collide (none
 * do today, but keep it defensive).
 */
function buildRoutes(): Route[] {
  return [
    // Health check is always open (the auth middleware bypasses it too).
    { method: "GET", pattern: "/healthz", handler: () => new Response("ok", { status: 200 }) },

    // Dashboard + JSON status feed.
    {
      method: "GET",
      pattern: "/",
      handler: ({ store, runtime }) =>
        dashboardRoute({ store, cfg: loadConfigFromStore(store), runtime }),
    },
    {
      method: "GET",
      pattern: "/api/status",
      handler: ({ store, runtime }) => statusApiRoute({ store, runtime }),
    },

    // Config GETs.
    {
      method: "GET",
      pattern: "/config",
      handler: ({ store }) => configRoute({ store, cfg: loadConfigFromStore(store) }),
    },
    {
      method: "GET",
      pattern: /^\/config\/orgs\/([^/]+)\/edit$/,
      handler: ({ store, match }) =>
        orgEditRoute({
          store,
          cfg: loadConfigFromStore(store),
          name: decodeURIComponent(match![1]!),
        }),
    },
    {
      method: "GET",
      pattern: /^\/config\/repos\/([^/]+)\/([^/]+)\/edit$/,
      handler: ({ store, match }) => {
        const slug = `${decodeURIComponent(match![1]!)}/${decodeURIComponent(match![2]!)}`;
        return repoEditRoute({ store, cfg: loadConfigFromStore(store), slug });
      },
    },

    // Events.
    { method: "GET", pattern: "/events", handler: ({ store }) => eventsRoute({ store }) },

    // Review detail. Placed AFTER /config/* GETs — the three-segment
    // pattern couldn't match any of them, but keeping the order
    // semantically route-specific -> route-specific -> review fallback
    // makes additions safer if anyone ever changes shapes.
    {
      method: "GET",
      pattern: /^\/reviews\/([^/]+)\/([^/]+)\/(\d+)$/,
      handler: ({ store, match }) => {
        const owner = decodeURIComponent(match![1]!);
        const name = decodeURIComponent(match![2]!);
        const pr = Number(match![3]);
        return reviewDetailRoute({ store, repo: `${owner}/${name}`, pr });
      },
    },

    // Config POSTs — form submissions from the UI.
    {
      method: "POST",
      pattern: "/config/general",
      handler: async ({ req, store }) => {
        const form = await req.formData();
        const currentCfg = loadConfigFromStore(store);
        const res = await handleGeneralPost(store, form, currentCfg);
        if (!res.ok) {
          // Re-render /config with the submitted candidate + error banner,
          // so the user keeps their edits and sees every field issue at once.
          return configRoute({ store, cfg: res.candidate, errors: res.errors });
        }
        return redirect("/config");
      },
    },
    {
      method: "POST",
      pattern: "/config/orgs",
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
      handler: async ({ req, store, match }) => {
        const form = await req.formData();
        return handleOrgEditPost(store, decodeURIComponent(match![1]!), form);
      },
    },
    {
      method: "POST",
      pattern: "/config/repos",
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
      handler: async ({ req, store, match }) => {
        const slug = `${decodeURIComponent(match![1]!)}/${decodeURIComponent(match![2]!)}`;
        const form = await req.formData();
        return handleRepoEditPost(store, slug, form);
      },
    },

    // One-shot actions.
    {
      method: "POST",
      pattern: "/actions/toggle-dry-run",
      handler: ({ store }) => handleToggleDryRun(store),
    },
    {
      method: "POST",
      pattern: "/actions/recheck",
      handler: async ({ req, store }) => {
        const form = await req.formData();
        return handleRecheck(store, form);
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
  const { store, runtime, host, port, password } = deps;
  const routes = buildRoutes();

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

      // /healthz is always open so Docker healthchecks and reverse proxies work
      // without needing credentials. Everything else goes through basic auth
      // when AUTO_REVIEWER_PASSWORD is set.
      if (url.pathname !== "/healthz") {
        const unauthorized = requireAuth(req, password);
        if (unauthorized) return unauthorized;
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
        return await hit.route.handler({
          req,
          url,
          match: hit.match,
          store,
          runtime,
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
