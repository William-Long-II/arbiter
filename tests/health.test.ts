import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../src/state/db.ts";
import { healthRoute, resolveVersionInfo, versionRoute, type VersionInfo } from "../src/web/routes/health.ts";
import { createRuntime } from "../src/web/runtime.ts";
import { Breaker } from "../src/review/breaker.ts";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "auto-reviewer-test-"));
  return {
    path: join(dir, "state.sqlite"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // leave it for the OS temp cleaner
      }
    },
  };
}

function makeRuntime() {
  return createRuntime({
    bootstrappedFromYaml: false,
    breaker: new Breaker({ threshold: 5, cooldownMs: 60_000, onTransition: () => {} }),
  });
}

describe("healthRoute", () => {
  test("fresh not-yet-configured install → status=degraded, HTTP 200, loop.ok=true (loop idle by design)", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      const res = healthRoute({
        store,
        runtime,
        pollIntervalSeconds: 60,
        configured: false,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        checks: { sqlite: { ok: boolean }; loop: { ok: boolean }; breaker: { ok: boolean }; configured: { ok: boolean } };
      };
      expect(body.status).toBe("degraded");
      expect(body.checks.sqlite.ok).toBe(true);
      expect(body.checks.loop.ok).toBe(true); // not-configured exempt
      expect(body.checks.breaker.ok).toBe(true);
      expect(body.checks.configured.ok).toBe(false);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("configured + recent tick → status=ok, HTTP 200", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      runtime.lastTickStart = new Date().toISOString();
      const res = healthRoute({
        store,
        runtime,
        pollIntervalSeconds: 60,
        configured: true,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        checks: { loop: { ok: boolean; secondsSinceLastTick: number } };
      };
      expect(body.status).toBe("ok");
      expect(body.checks.loop.ok).toBe(true);
      expect(body.checks.loop.secondsSinceLastTick).toBeLessThanOrEqual(5);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("configured + no tick → loop.ok=false, status=degraded", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      // lastTickStart stays null — no tick has run.
      const res = healthRoute({
        store,
        runtime,
        pollIntervalSeconds: 60,
        configured: true,
      });
      expect(res.status).toBe(200); // degraded is still 200
      const body = (await res.json()) as {
        status: string;
        checks: { loop: { ok: boolean; detail: string } };
      };
      expect(body.status).toBe("degraded");
      expect(body.checks.loop.ok).toBe(false);
      expect(body.checks.loop.detail).toContain("no tick");
      store.close();
    } finally {
      cleanup();
    }
  });

  test("configured + stale tick (> 3× poll interval) → loop.ok=false", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      // Set last tick to 5 minutes ago, poll interval 60s. 5min = 300s > 3×60=180s.
      runtime.lastTickStart = new Date(Date.now() - 300_000).toISOString();
      const res = healthRoute({
        store,
        runtime,
        pollIntervalSeconds: 60,
        configured: true,
      });
      const body = (await res.json()) as {
        status: string;
        checks: { loop: { ok: boolean; detail: string; secondsSinceLastTick: number } };
      };
      expect(body.checks.loop.ok).toBe(false);
      expect(body.checks.loop.secondsSinceLastTick).toBeGreaterThanOrEqual(300);
      expect(body.checks.loop.detail).toContain("threshold");
      expect(body.status).toBe("degraded");
      store.close();
    } finally {
      cleanup();
    }
  });

  test("breaker open → breaker.ok=false, status=degraded", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      runtime.lastTickStart = new Date().toISOString();
      // Trip the breaker.
      for (let i = 0; i < 6; i++) runtime.breaker.recordFailure("test");
      const res = healthRoute({
        store,
        runtime,
        pollIntervalSeconds: 60,
        configured: true,
      });
      const body = (await res.json()) as {
        status: string;
        checks: { breaker: { ok: boolean; kind: string; detail: string } };
      };
      expect(body.checks.breaker.ok).toBe(false);
      expect(body.checks.breaker.kind).toBe("open");
      expect(body.checks.breaker.detail).toContain("breaker open");
      expect(body.status).toBe("degraded");
      store.close();
    } finally {
      cleanup();
    }
  });

  test("sqlite broken → status=down, HTTP 503", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      runtime.lastTickStart = new Date().toISOString();
      // Close the underlying DB so the PRAGMA inside healthRoute throws.
      store.db.close();
      const res = healthRoute({
        store,
        runtime,
        pollIntervalSeconds: 60,
        configured: true,
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { status: string; checks: { sqlite: { ok: boolean } } };
      expect(body.status).toBe("down");
      expect(body.checks.sqlite.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("staleness threshold is at least 60s even when poll interval is tiny", async () => {
    // If someone sets poll_interval=10s, 3× = 30s, which would flap the
    // healthcheck during a long Claude call (several minutes). The floor
    // keeps small intervals from creating false-positive unhealthy signals.
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      runtime.lastTickStart = new Date(Date.now() - 45_000).toISOString();
      const res = healthRoute({
        store,
        runtime,
        pollIntervalSeconds: 10,
        configured: true,
      });
      const body = (await res.json()) as { checks: { loop: { ok: boolean } } };
      // 45s ago with pollInterval=10 would be 3×10=30s threshold, but the
      // floor of 60s protects us. So loop.ok should still be true.
      expect(body.checks.loop.ok).toBe(true);
      store.close();
    } finally {
      cleanup();
    }
  });
});

describe("versionRoute + resolveVersionInfo", () => {
  test("resolveVersionInfo reads AUTO_REVIEWER_COMMIT + BUILT_AT when set", () => {
    const prevCommit = process.env.AUTO_REVIEWER_COMMIT;
    const prevBuiltAt = process.env.AUTO_REVIEWER_BUILT_AT;
    process.env.AUTO_REVIEWER_COMMIT = "abc123def";
    process.env.AUTO_REVIEWER_BUILT_AT = "2026-01-01T00:00:00Z";
    try {
      const info = resolveVersionInfo("0.2.0");
      expect(info).toEqual({
        version: "0.2.0",
        commit: "abc123def",
        built_at: "2026-01-01T00:00:00Z",
      });
    } finally {
      if (prevCommit !== undefined) process.env.AUTO_REVIEWER_COMMIT = prevCommit;
      else delete process.env.AUTO_REVIEWER_COMMIT;
      if (prevBuiltAt !== undefined) process.env.AUTO_REVIEWER_BUILT_AT = prevBuiltAt;
      else delete process.env.AUTO_REVIEWER_BUILT_AT;
    }
  });

  test("resolveVersionInfo falls back to 'dev' + null when env is unset", () => {
    const prevCommit = process.env.AUTO_REVIEWER_COMMIT;
    const prevBuiltAt = process.env.AUTO_REVIEWER_BUILT_AT;
    delete process.env.AUTO_REVIEWER_COMMIT;
    delete process.env.AUTO_REVIEWER_BUILT_AT;
    try {
      const info = resolveVersionInfo("0.1.0");
      expect(info).toEqual({
        version: "0.1.0",
        commit: "dev",
        built_at: null,
      });
    } finally {
      if (prevCommit !== undefined) process.env.AUTO_REVIEWER_COMMIT = prevCommit;
      if (prevBuiltAt !== undefined) process.env.AUTO_REVIEWER_BUILT_AT = prevBuiltAt;
    }
  });

  test("versionRoute returns JSON with the provided info", async () => {
    const info: VersionInfo = { version: "1.2.3", commit: "deadbeef", built_at: "2026-02-02T00:00:00Z" };
    const res = versionRoute({ info });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(info);
  });
});
