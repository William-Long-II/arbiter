import type { Store } from "../../state/db.ts";
import { computeMetrics, type MetricsWindow } from "../../metrics.ts";

/**
 * GET /api/metrics?window=24h|7d|30d
 *
 * Separate endpoint from /api/status because metrics are slower to compute
 * (scans events + reviews) and don't need to update every 5s — the Dashboard
 * polls this on a 60s interval. 60s in-process cache (see metrics.ts)
 * dedupes concurrent tabs.
 */
export function metricsApiRoute(args: { store: Store; url: URL }): Response {
  const raw = args.url.searchParams.get("window") ?? "7d";
  const window: MetricsWindow = raw === "24h" || raw === "30d" ? raw : "7d";
  const metrics = computeMetrics(args.store, window);
  return new Response(JSON.stringify(metrics), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
