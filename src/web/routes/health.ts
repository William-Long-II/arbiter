import type { Store } from "../../state/db.ts";
import type { Runtime } from "../runtime.ts";

/**
 * Health + version endpoints.
 *
 * /healthz is hit by container orchestrators, reverse proxies, and
 * uptime monitors. It MUST be cheap (ideally one query per check) and
 * it MUST differentiate "process is up" from "process is actually
 * doing work." A 200 on a silently-stuck service is worse than no
 * healthcheck at all.
 *
 * The old implementation returned a static "ok" — that's enough to
 * tell Docker the container is up, but not enough to catch:
 *   - sqlite gone unreachable (disk full, permissions regression)
 *   - the review loop wedged for hours (tick.failed + nothing retries)
 *   - the circuit breaker stuck open (no reviews happening)
 *
 * The new `/healthz` reports all three. It returns 503 on any
 * "broken" state so the upstream monitor can act, and JSON details
 * so an operator can see WHY without shelling in.
 */
export type HealthStatus = {
  status: "ok" | "degraded" | "down";
  checks: {
    sqlite: { ok: boolean; detail?: string };
    integrity: { ok: boolean; detail: string };
    loop: { ok: boolean; detail: string; lastTickStart: string | null; secondsSinceLastTick: number | null };
    breaker: { ok: boolean; detail: string; kind: "closed" | "open" | "half_open" };
    configured: { ok: boolean; detail: string };
  };
  /** When computing the response began. Useful for diffing against server logs. */
  at: string;
};

export function healthRoute(args: {
  store: Store;
  runtime: Runtime;
  pollIntervalSeconds: number;
  /**
   * True when the config has the minimum required fields set (bot user +
   * at least one org/repo). Passed in rather than re-derived here so the
   * health endpoint stays cheap — no zod re-parse per probe.
   */
  configured: boolean;
}): Response {
  const { store, runtime, pollIntervalSeconds, configured } = args;

  // sqlite: a lightweight query. PRAGMA is cheaper than SELECT COUNT().
  let sqlite: HealthStatus["checks"]["sqlite"];
  try {
    store.db.prepare("PRAGMA user_version").get();
    sqlite = { ok: true };
  } catch (e) {
    sqlite = { ok: false, detail: (e as Error).message.slice(0, 200) };
  }

  // integrity: reflects the boot-time PRAGMA integrity_check result.
  // Doesn't re-run per request — integrity_check is linear in DB size and
  // we'd be hammering it on every uptime probe. Surfacing the cached
  // result is enough to make the "DB corrupted, please restore" state
  // visible to an operator who's watching /healthz.
  const integrityMeta = store.meta.integrity;
  const integrity: HealthStatus["checks"]["integrity"] =
    integrityMeta === null
      ? { ok: true, detail: "freshly-created DB; nothing to check yet" }
      : integrityMeta === "ok"
        ? { ok: true, detail: "ok (last checked at boot)" }
        : { ok: false, detail: `integrity_check failed at boot: ${integrityMeta.error}` };

  // loop liveness: a tick hasn't happened in a while → probably stuck.
  // Threshold is 3× the configured poll interval — enough slack to absorb
  // one long tick, not enough to miss a dead process for an hour.
  const now = Date.now();
  const lastTickStart = runtime.lastTickStart;
  const secondsSinceLastTick = lastTickStart
    ? Math.floor((now - Date.parse(lastTickStart)) / 1000)
    : null;
  const tickStaleAfter = Math.max(60, pollIntervalSeconds * 3);
  let loop: HealthStatus["checks"]["loop"];
  if (!configured) {
    // Before setup is done, the loop deliberately doesn't run, so "no
    // ticks yet" is fine. Don't red-flag a fresh install.
    loop = { ok: true, detail: "not configured; loop idle by design", lastTickStart, secondsSinceLastTick };
  } else if (secondsSinceLastTick === null) {
    loop = {
      ok: false,
      detail: "no tick has started since boot",
      lastTickStart,
      secondsSinceLastTick,
    };
  } else if (secondsSinceLastTick > tickStaleAfter) {
    loop = {
      ok: false,
      detail: `last tick was ${secondsSinceLastTick}s ago (threshold ${tickStaleAfter}s = 3× poll interval)`,
      lastTickStart,
      secondsSinceLastTick,
    };
  } else {
    loop = {
      ok: true,
      detail: `last tick ${secondsSinceLastTick}s ago`,
      lastTickStart,
      secondsSinceLastTick,
    };
  }

  // breaker: open = no reviews are running. Report ok=false but keep
  // it as "degraded" not "down" since the process itself is fine.
  const breakerState = runtime.breaker.inspect();
  const breaker: HealthStatus["checks"]["breaker"] =
    breakerState.kind === "open"
      ? { ok: false, detail: `breaker open: ${breakerState.lastReason ?? "unknown reason"}`, kind: "open" }
      : { ok: true, detail: breakerState.kind, kind: breakerState.kind };

  const configuredCheck: HealthStatus["checks"]["configured"] = configured
    ? { ok: true, detail: "bot_username set, at least one org/repo watched" }
    : { ok: false, detail: "initial setup incomplete (bot_username or watched repos missing)" };

  // Roll-up: down if sqlite is broken OR the integrity check failed at
  // boot (both indicate the process can't safely do its job); degraded
  // if the loop is stuck, breaker is open, or setup isn't done.
  // Everything else → ok.
  let status: HealthStatus["status"];
  if (!sqlite.ok || !integrity.ok) status = "down";
  else if (!loop.ok || !breaker.ok || !configuredCheck.ok) status = "degraded";
  else status = "ok";

  const body: HealthStatus = {
    status,
    checks: { sqlite, integrity, loop, breaker, configured: configuredCheck },
    at: new Date().toISOString(),
  };

  // 503 on down only. Degraded returns 200 so a container orchestrator
  // doesn't kill the pod just because the operator hasn't finished
  // initial setup or the breaker is temporarily open. An uptime monitor
  // that cares about degraded specifically can parse the JSON.
  const httpStatus = status === "down" ? 503 : 200;
  return new Response(JSON.stringify(body, null, 2), {
    status: httpStatus,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Build-time identity — the git SHA and version string this process
 * was built from. Used to confirm which commit is running without
 * shelling into the container.
 */
export type VersionInfo = {
  version: string;
  commit: string;
  built_at: string | null;
};

export function versionRoute(args: { info: VersionInfo }): Response {
  return new Response(JSON.stringify(args.info, null, 2), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Resolve build-time identity from environment variables and package.json.
 * Done once at boot; the result is passed into versionRoute / the
 * dashboard renderer.
 *
 * - AUTO_REVIEWER_COMMIT is set at image build time by the Dockerfile
 *   (from GITHUB_SHA or `git rev-parse HEAD`). Falls back to "dev"
 *   outside of containers.
 * - AUTO_REVIEWER_BUILT_AT is an ISO timestamp similarly injected. Null
 *   when unset.
 * - Version string comes from package.json.
 */
export function resolveVersionInfo(packageVersion: string): VersionInfo {
  return {
    version: packageVersion,
    commit: process.env.AUTO_REVIEWER_COMMIT ?? "dev",
    built_at: process.env.AUTO_REVIEWER_BUILT_AT ?? null,
  };
}

/**
 * Module-level current-version holder. Set by startWebServer once at
 * boot; read by layout() for the footer badge. Using a module-level
 * singleton here — instead of threading versionInfo through every route
 * — because the value never changes at runtime and is purely for
 * display; a mis-read is impossible.
 */
let currentVersion: VersionInfo | null = null;
export function setCurrentVersionInfo(v: VersionInfo): void {
  currentVersion = v;
}
export function getCurrentVersionInfo(): VersionInfo | null {
  return currentVersion;
}
