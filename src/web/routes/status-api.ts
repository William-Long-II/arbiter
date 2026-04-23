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
  const recentReviews = store.recentReviews(50).map((r) => {
    const [owner, name] = r.repo.split("/");
    return {
      repo: r.repo,
      pr_number: r.pr_number,
      head_sha: r.head_sha,
      verdict: r.verdict,
      reviewed_at: r.reviewed_at,
      // Pre-computed URL so the client doesn't have to know the routing
      // scheme. Uses the same two-segment form as the server-side matcher.
      detail_url: `/reviews/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/${r.pr_number}`,
    };
  });
  const body = {
    now: new Date().toISOString(),
    mode: cfg.review.dry_run ? "dry-run" : "live",
    approvalsInLastHour: store.approvalsInLastHour(),
    approvalCap: cfg.review.max_approvals_per_hour,
    pollIntervalSeconds: cfg.poll.interval_seconds,
    lastTickStart: runtime.lastTickStart,
    lastTickEnd: runtime.lastTickEnd,
    lastTickError: runtime.lastTickError,
    nextTickAt: runtime.nextTickAt,
    currentPrs: runtime.currentPrs,
    lastActivityAt: runtime.lastActivityAt,
    concurrency: cfg.review.concurrency,
    storage: {
      path: store.meta.path,
      freshlyCreated: store.meta.freshlyCreated,
      sizeBytes: store.meta.sizeBytes,
      counts,
    },
    recentReviews,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
