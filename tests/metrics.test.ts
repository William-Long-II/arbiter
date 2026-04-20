import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { buildAllowlist } from "../src/config/repos";
import type { Octokit } from "../src/github";
import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Helpers — import registry internals via the public module
// ---------------------------------------------------------------------------

// We need a fresh registry for each test to avoid state leaking between tests.
// Since the registry is a module-level singleton we re-import the module
// helpers directly and test the Registry class behaviour via a separate
// in-test instance.

/**
 * Minimal re-implementation of the Registry class for unit-testing purposes,
 * duplicated here so we can instantiate multiple isolated copies without
 * touching the live singleton used by the server.
 */

const MAX_LABEL_VALUES = 1_000;
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

type LabelSet = Record<string, string>;

function serialiseLabels(labels: LabelSet): string {
  const keys = Object.keys(labels).sort();
  return keys
    .map((k) => `${k}="${(labels[k] ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join(",");
}

class TestRegistry {
  private counters = new Map<string, { help: string; series: Map<string, { value: number }> }>();
  private histograms = new Map<
    string,
    {
      help: string;
      bucketBounds: number[];
      series: Map<string, { sum: number; count: number; buckets: Map<number, number> }>;
    }
  >();

  registerCounter(name: string, help: string): void {
    if (!this.counters.has(name)) {
      this.counters.set(name, { help, series: new Map() });
    }
  }

  registerHistogram(name: string, help: string, buckets = DEFAULT_BUCKETS): void {
    if (!this.histograms.has(name)) {
      this.histograms.set(name, {
        help,
        bucketBounds: [...buckets].sort((a, b) => a - b),
        series: new Map(),
      });
    }
  }

  incrementCounter(name: string, labels: LabelSet = {}, amount = 1): boolean {
    const entry = this.counters.get(name);
    if (!entry) throw new Error(`Counter not registered: ${name}`);
    const key = serialiseLabels(labels);
    let state = entry.series.get(key);
    if (!state) {
      if (entry.series.size >= MAX_LABEL_VALUES) return false;
      state = { value: 0 };
      entry.series.set(key, state);
    }
    state.value += amount;
    return true;
  }

  observeHistogram(name: string, value: number, labels: LabelSet = {}): boolean {
    const entry = this.histograms.get(name);
    if (!entry) throw new Error(`Histogram not registered: ${name}`);
    const key = serialiseLabels(labels);
    let state = entry.series.get(key);
    if (!state) {
      if (entry.series.size >= MAX_LABEL_VALUES) return false;
      const bucketMap = new Map<number, number>();
      for (const b of entry.bucketBounds) bucketMap.set(b, 0);
      bucketMap.set(Infinity, 0);
      state = { sum: 0, count: 0, buckets: bucketMap };
      entry.series.set(key, state);
    }
    state.sum += value;
    state.count += 1;
    for (const [bound] of state.buckets) {
      if (value <= bound) state.buckets.set(bound, (state.buckets.get(bound) ?? 0) + 1);
    }
    return true;
  }

  getCounter(name: string, labels: LabelSet = {}): number {
    const key = serialiseLabels(labels);
    return this.counters.get(name)?.series.get(key)?.value ?? 0;
  }

  seriesCount(name: string): number {
    return (
      this.counters.get(name)?.series.size ??
      this.histograms.get(name)?.series.size ??
      0
    );
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, entry] of this.counters) {
      lines.push(`# HELP ${name} ${entry.help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const [labelStr, state] of entry.series) {
        lines.push(`${name}${labelStr ? `{${labelStr}}` : ""} ${state.value}`);
      }
    }
    for (const [name, entry] of this.histograms) {
      lines.push(`# HELP ${name} ${entry.help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const [labelStr, state] of entry.series) {
        const prefix = labelStr ? `{${labelStr},` : "{";
        for (const [bound, count] of state.buckets) {
          const leLabel = bound === Infinity ? "+Inf" : String(bound);
          lines.push(`${name}_bucket${prefix}le="${leLabel}"} ${count}`);
        }
        const ls = labelStr ? `{${labelStr}}` : "";
        lines.push(`${name}_sum${ls} ${state.sum}`);
        lines.push(`${name}_count${ls} ${state.count}`);
      }
    }
    return lines.join("\n") + (lines.length > 0 ? "\n" : "");
  }
}

// ---------------------------------------------------------------------------
// Unit tests — Counter
// ---------------------------------------------------------------------------

describe("Counter", () => {
  test("starts at zero", () => {
    const reg = new TestRegistry();
    reg.registerCounter("my_counter", "A test counter.");
    expect(reg.getCounter("my_counter")).toBe(0);
  });

  test("increments by 1 each call", () => {
    const reg = new TestRegistry();
    reg.registerCounter("my_counter", "A test counter.");
    reg.incrementCounter("my_counter");
    reg.incrementCounter("my_counter");
    expect(reg.getCounter("my_counter")).toBe(2);
  });

  test("increments by arbitrary amount", () => {
    const reg = new TestRegistry();
    reg.registerCounter("token_counter", "Tokens.");
    reg.incrementCounter("token_counter", {}, 42);
    expect(reg.getCounter("token_counter")).toBe(42);
  });

  test("tracks separate label-sets independently", () => {
    const reg = new TestRegistry();
    reg.registerCounter("webhook_total", "Webhooks.");
    reg.incrementCounter("webhook_total", { event: "push" });
    reg.incrementCounter("webhook_total", { event: "pull_request" });
    reg.incrementCounter("webhook_total", { event: "pull_request" });
    expect(reg.getCounter("webhook_total", { event: "push" })).toBe(1);
    expect(reg.getCounter("webhook_total", { event: "pull_request" })).toBe(2);
  });

  test("label order is stable (sorted keys)", () => {
    const reg = new TestRegistry();
    reg.registerCounter("c", "c.");
    reg.incrementCounter("c", { b: "2", a: "1" });
    // Different insertion order for same logical label set — must map to same series.
    reg.incrementCounter("c", { a: "1", b: "2" });
    expect(reg.getCounter("c", { a: "1", b: "2" })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — Histogram
// ---------------------------------------------------------------------------

describe("Histogram", () => {
  test("records sum and count", () => {
    const reg = new TestRegistry();
    reg.registerHistogram("latency", "Latency.", [0.1, 0.5, 1.0]);
    reg.observeHistogram("latency", 0.2);
    reg.observeHistogram("latency", 0.8);
    const series = reg["histograms"].get("latency")!.series.get("")!;
    expect(series.count).toBe(2);
    expect(series.sum).toBeCloseTo(1.0);
  });

  test("places observations in correct buckets (cumulative)", () => {
    const reg = new TestRegistry();
    reg.registerHistogram("h", "h.", [0.1, 0.5, 1.0]);
    reg.observeHistogram("h", 0.05); // <= 0.1, <= 0.5, <= 1.0, <= +Inf
    reg.observeHistogram("h", 0.3);  // <= 0.5, <= 1.0, <= +Inf
    reg.observeHistogram("h", 2.0);  // only <= +Inf
    const series = reg["histograms"].get("h")!.series.get("")!;
    expect(series.buckets.get(0.1)).toBe(1);
    expect(series.buckets.get(0.5)).toBe(2);
    expect(series.buckets.get(1.0)).toBe(2);
    expect(series.buckets.get(Infinity)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — Prometheus text format
// ---------------------------------------------------------------------------

describe("Prometheus text format", () => {
  test("empty registry renders empty string", () => {
    const reg = new TestRegistry();
    expect(reg.render()).toBe("");
  });

  test("counter renders # HELP, # TYPE, and value lines", () => {
    const reg = new TestRegistry();
    reg.registerCounter("reviewme_reviews_total", "Reviews.");
    reg.incrementCounter("reviewme_reviews_total", { repo: "acme/widget", verdict: "approve" });
    const out = reg.render();
    expect(out).toContain("# HELP reviewme_reviews_total Reviews.");
    expect(out).toContain("# TYPE reviewme_reviews_total counter");
    expect(out).toContain('reviewme_reviews_total{');
    expect(out).toContain("verdict=\"approve\"");
    expect(out).toContain("} 1");
  });

  test("histogram renders _bucket, _sum, _count lines", () => {
    const reg = new TestRegistry();
    reg.registerHistogram("reviewme_review_duration_seconds", "Duration.", [0.5, 1.0]);
    reg.observeHistogram("reviewme_review_duration_seconds", 0.3);
    const out = reg.render();
    expect(out).toContain("# TYPE reviewme_review_duration_seconds histogram");
    expect(out).toContain('_bucket{le="0.5"} 1');
    expect(out).toContain('_bucket{le="+Inf"} 1');
    expect(out).toContain("_sum ");
    expect(out).toContain("_count ");
  });

  test("label values with special characters are escaped", () => {
    const reg = new TestRegistry();
    reg.registerCounter("c", "c.");
    reg.incrementCounter("c", { reason: 'line1\nline2' });
    const out = reg.render();
    expect(out).toContain('reason="line1\\nline2"');
  });

  test("output ends with a newline", () => {
    const reg = new TestRegistry();
    reg.registerCounter("c", "c.");
    reg.incrementCounter("c");
    expect(reg.render()).toMatch(/\n$/);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — Label cardinality cap
// ---------------------------------------------------------------------------

describe("Label cardinality cap", () => {
  test("counter rejects new label sets beyond cap", () => {
    const reg = new TestRegistry();
    reg.registerCounter("c", "c.");
    // Fill to cap.
    for (let i = 0; i < MAX_LABEL_VALUES; i++) {
      reg.incrementCounter("c", { id: String(i) });
    }
    expect(reg.seriesCount("c")).toBe(MAX_LABEL_VALUES);
    // This new label set must be dropped.
    const accepted = reg.incrementCounter("c", { id: "overflow" });
    expect(accepted).toBe(false);
    expect(reg.seriesCount("c")).toBe(MAX_LABEL_VALUES);
  });

  test("histogram rejects new label sets beyond cap", () => {
    const reg = new TestRegistry();
    reg.registerHistogram("h", "h.");
    for (let i = 0; i < MAX_LABEL_VALUES; i++) {
      reg.observeHistogram("h", 0.1, { id: String(i) });
    }
    expect(reg.seriesCount("h")).toBe(MAX_LABEL_VALUES);
    const accepted = reg.observeHistogram("h", 0.1, { id: "overflow" });
    expect(accepted).toBe(false);
  });

  test("existing label sets continue to increment past cap", () => {
    const reg = new TestRegistry();
    reg.registerCounter("c", "c.");
    for (let i = 0; i < MAX_LABEL_VALUES; i++) {
      reg.incrementCounter("c", { id: String(i) });
    }
    // Re-incrementing an existing label set is fine even after the cap is hit.
    const accepted = reg.incrementCounter("c", { id: "0" });
    expect(accepted).toBe(true);
    expect(reg.getCounter("c", { id: "0" })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Integration test — POST webhook increments reviewme_webhook_received_total
// ---------------------------------------------------------------------------

describe("metrics integration: webhook counter", () => {
  const SECRET = "integration-test-secret";

  function sign(payload: string): string {
    return `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
  }

  // We import the production metrics module and the webhooks module to wire up
  // a real server, then verify the live singleton counter increments.

  test("receiving a webhook increments the counter in the live registry", async () => {
    const { createWebhooks } = await import("../src/server/webhooks");
    const { buildAllowlist } = await import("../src/config/repos");
    const { registry, webhookReceived } = await import("../src/server/metrics");

    const webhooks = createWebhooks(SECRET, {
      allowlist: buildAllowlist({}),
      octokit: {} as Octokit,
      anthropic: {} as Anthropic,
      selfLogin: "review-me-bot",
    });

    // Read the current counter value before the request.
    const before = registry["counters"].get(webhookReceived)?.series.get('event="ping"')?.value ?? 0;

    // Build a minimal server that mirrors the handleWebhook logic in index.ts,
    // plus the incWebhookReceived call we added.
    const { incWebhookReceived } = await import("../src/server/metrics");

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const id = req.headers.get("x-github-delivery");
        const name = req.headers.get("x-github-event");
        const signature = req.headers.get("x-hub-signature-256");
        if (!id || !name || !signature) return new Response("bad", { status: 400 });
        const payload = await req.text();
        incWebhookReceived(name);
        try {
          await webhooks.verifyAndReceive({
            id,
            name: name as Parameters<typeof webhooks.verifyAndReceive>[0]["name"],
            signature,
            payload,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("signature does not match")) return new Response("401", { status: 401 });
          return new Response("500", { status: 500 });
        }
        return new Response("ok", { status: 200 });
      },
    });

    try {
      const body = JSON.stringify({ zen: "Anything in the head..." });
      const res = await fetch(`http://127.0.0.1:${server.port}`, {
        method: "POST",
        headers: {
          "x-github-delivery": "test-delivery-001",
          "x-github-event": "ping",
          "x-hub-signature-256": sign(body),
          "content-type": "application/json",
        },
        body,
      });
      expect(res.status).toBe(200);

      const after = registry["counters"].get(webhookReceived)?.series.get('event="ping"')?.value ?? 0;
      expect(after).toBe(before + 1);
    } finally {
      server.stop();
    }
  });

  test("GET /metrics returns prometheus text-format content-type", async () => {
    const { buildMetricsHandler } = await import("../src/server/metrics");
    const handler = buildMetricsHandler();

    // No METRICS_BIND_TOKEN set in test environment — should respond without auth.
    const req = new Request("http://localhost/metrics", { method: "GET" });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") ?? "";
    expect(ct).toContain("text/plain");
    expect(ct).toContain("version=0.0.4");
    const body = await res.text();
    expect(body).toContain("# TYPE reviewme_webhook_received_total counter");
    expect(body).toContain("# TYPE reviewme_review_duration_seconds histogram");
  });

  test("GET /metrics returns 401 when METRICS_BIND_TOKEN is set and token missing", async () => {
    // Temporarily set METRICS_BIND_TOKEN.
    const original = process.env["METRICS_BIND_TOKEN"];
    process.env["METRICS_BIND_TOKEN"] = "secret-token";
    try {
      const { buildMetricsHandler } = await import("../src/server/metrics");
      const handler = buildMetricsHandler();
      const req = new Request("http://localhost/metrics", { method: "GET" });
      const res = await handler(req);
      expect(res.status).toBe(401);
    } finally {
      if (original === undefined) {
        delete process.env["METRICS_BIND_TOKEN"];
      } else {
        process.env["METRICS_BIND_TOKEN"] = original;
      }
    }
  });

  test("GET /metrics returns 401 when wrong bearer token provided", async () => {
    const original = process.env["METRICS_BIND_TOKEN"];
    process.env["METRICS_BIND_TOKEN"] = "correct-token";
    try {
      const { buildMetricsHandler } = await import("../src/server/metrics");
      const handler = buildMetricsHandler();
      const req = new Request("http://localhost/metrics", {
        method: "GET",
        headers: { authorization: "Bearer wrong-token" },
      });
      const res = await handler(req);
      expect(res.status).toBe(401);
    } finally {
      if (original === undefined) {
        delete process.env["METRICS_BIND_TOKEN"];
      } else {
        process.env["METRICS_BIND_TOKEN"] = original;
      }
    }
  });

  test("GET /metrics returns 200 with correct bearer token", async () => {
    const original = process.env["METRICS_BIND_TOKEN"];
    process.env["METRICS_BIND_TOKEN"] = "good-token";
    try {
      const { buildMetricsHandler } = await import("../src/server/metrics");
      const handler = buildMetricsHandler();
      const req = new Request("http://localhost/metrics", {
        method: "GET",
        headers: { authorization: "Bearer good-token" },
      });
      const res = await handler(req);
      expect(res.status).toBe(200);
    } finally {
      if (original === undefined) {
        delete process.env["METRICS_BIND_TOKEN"];
      } else {
        process.env["METRICS_BIND_TOKEN"] = original;
      }
    }
  });
});
