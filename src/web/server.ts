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
import { handleRecheck, handleToggleDryRun } from "./routes/actions.ts";
import { redirect } from "./html.ts";
import { log } from "../log.ts";

export type ServerDeps = {
  store: Store;
  runtime: Runtime;
  host: string;
  port: number;
};

export function startWebServer(deps: ServerDeps) {
  const { store, runtime, host, port } = deps;

  const selfOrigin = `http://${host}:${port}`;

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

      // Same-origin guard for state-changing requests.
      if (method !== "GET" && method !== "HEAD") {
        const origin = req.headers.get("origin") ?? req.headers.get("referer") ?? "";
        if (origin && !origin.startsWith(selfOrigin)) {
          return new Response("Cross-origin POST refused", { status: 403 });
        }
      }

      try {
        // Always load config fresh — UI edits must be visible to the UI immediately.
        const cfg = loadConfigFromStore(store);

        if (method === "GET" && url.pathname === "/") {
          return dashboardRoute({ store, cfg, runtime });
        }
        if (method === "GET" && url.pathname === "/healthz") {
          return new Response("ok", { status: 200 });
        }
        if (method === "GET" && url.pathname === "/config") {
          return configRoute({ store, cfg });
        }
        if (method === "GET" && url.pathname === "/events") {
          return eventsRoute({ store });
        }

        // /reviews/:owner/:name/:pr
        const rm = url.pathname.match(/^\/reviews\/([^/]+)\/([^/]+)\/(\d+)$/);
        if (method === "GET" && rm) {
          const owner = decodeURIComponent(rm[1]!);
          const name = decodeURIComponent(rm[2]!);
          const pr = Number(rm[3]);
          return reviewDetailRoute({ store, repo: `${owner}/${name}`, pr });
        }

        if (method === "POST" && url.pathname === "/config/general") {
          const form = await req.formData();
          const res = await handleGeneralPost(store, form);
          if (!res.ok) return errorPage(res.error);
          return redirect("/config");
        }
        if (method === "POST" && url.pathname === "/config/orgs") {
          const form = await req.formData();
          const res = handleOrgsPost(store, form);
          if (!res.ok) return errorPage(res.error);
          return redirect(res.redirect);
        }
        if (method === "POST" && url.pathname === "/config/repos") {
          const form = await req.formData();
          const res = handleReposPost(store, form);
          if (!res.ok) return errorPage(res.error);
          return redirect(res.redirect);
        }
        if (method === "POST" && url.pathname === "/actions/toggle-dry-run") {
          return handleToggleDryRun(store);
        }
        if (method === "POST" && url.pathname === "/actions/recheck") {
          const form = await req.formData();
          return handleRecheck(store, form);
        }

        return new Response("Not found", { status: 404 });
      } catch (e) {
        log.error("web.unhandled", { error: (e as Error).message, path: url.pathname });
        return new Response(`Error: ${(e as Error).message}`, { status: 500 });
      }
    },
  });

  log.info("web.listening", { host, port });
  return server;
}

function errorPage(msg: string): Response {
  return new Response(`Invalid input: ${msg}`, {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
