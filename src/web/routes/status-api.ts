import type { Store } from "../../state/db.ts";
import type { Runtime } from "../runtime.ts";
import { loadConfigFromStore } from "../../config.ts";

/**
 * Small JSON endpoint the dashboard polls so the stat cards stay in sync
 * with the loop without the user having to reload the page. Kept separate
 * from the HTML routes so the response is trivially cacheable-never.
 *
 * Sits behind the same auth as the rest of the UI — the browser already has
 * the basic-auth credentials cached and fetch() sends them along.
 */
export function statusApiRoute(args: { store: Store; runtime: Runtime }): Response {
  const { store, runtime } = args;
  const cfg = loadConfigFromStore(store);
  const counts = store.counts();
  const body = {
    now: new Date().toISOString(),
    mode: cfg.review.dry_run ? "dry-run" : "live",
    approvalsInLastHour: store.approvalsInLastHour(),
    approvalCap: cfg.review.max_approvals_per_hour,
    lastTickStart: runtime.lastTickStart,
    lastTickEnd: runtime.lastTickEnd,
    lastTickError: runtime.lastTickError,
    nextTickAt: runtime.nextTickAt,
    storage: {
      path: store.meta.path,
      freshlyCreated: store.meta.freshlyCreated,
      sizeBytes: store.meta.sizeBytes,
      counts,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
