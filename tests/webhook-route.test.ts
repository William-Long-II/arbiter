import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { openStore } from "../src/state/db.ts";
import { webhookRoute } from "../src/web/routes/webhook.ts";
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

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function makeRuntime() {
  return createRuntime({
    bootstrappedFromYaml: false,
    breaker: new Breaker({ threshold: 5, cooldownMs: 60_000, onTransition: () => {} }),
  });
}

function prBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "opened",
    pull_request: { number: 42, head: { sha: "abc123" } },
    repository: { name: "my-repo", owner: { login: "my-org" } },
    ...overrides,
  });
}

const SECRET = "a-shared-webhook-secret";

describe("webhookRoute", () => {
  test("503 when secret is not configured", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      const req = new Request("http://localhost/webhook/github", {
        method: "POST",
        body: prBody(),
      });
      const res = await webhookRoute({ req, store, runtime, secret: "" });
      expect(res.status).toBe(503);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("401 on missing signature", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      const req = new Request("http://localhost/webhook/github", {
        method: "POST",
        body: prBody(),
      });
      const res = await webhookRoute({ req, store, runtime, secret: SECRET });
      expect(res.status).toBe(401);
      expect(runtime.webhookQueue).toHaveLength(0);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("401 on bad signature", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      const body = prBody();
      const req = new Request("http://localhost/webhook/github", {
        method: "POST",
        body,
        headers: {
          "x-hub-signature-256": sign(body, "wrong-secret"),
          "x-github-event": "pull_request",
          "x-github-delivery": "deadbeef-0001",
        },
      });
      const res = await webhookRoute({ req, store, runtime, secret: SECRET });
      expect(res.status).toBe(401);
      expect(runtime.webhookQueue).toHaveLength(0);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("400 on missing delivery id", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      const body = prBody();
      const req = new Request("http://localhost/webhook/github", {
        method: "POST",
        body,
        headers: {
          "x-hub-signature-256": sign(body, SECRET),
          "x-github-event": "pull_request",
          // no x-github-delivery
        },
      });
      const res = await webhookRoute({ req, store, runtime, secret: SECRET });
      expect(res.status).toBe(400);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("200 + enqueued on valid pull_request.opened", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      const body = prBody();
      const req = new Request("http://localhost/webhook/github", {
        method: "POST",
        body,
        headers: {
          "x-hub-signature-256": sign(body, SECRET),
          "x-github-event": "pull_request",
          "x-github-delivery": "deadbeef-0002",
        },
      });
      const res = await webhookRoute({ req, store, runtime, secret: SECRET });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("enqueued");
      expect(runtime.webhookQueue).toHaveLength(1);
      expect(runtime.webhookQueue[0]!.repo).toEqual({ owner: "my-org", name: "my-repo" });
      expect(runtime.webhookQueue[0]!.number).toBe(42);
      expect(runtime.webhookQueue[0]!.head_sha).toBe("abc123");
      expect(runtime.wakeRequested).toBe(true);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("duplicate delivery is a 200 no-op (queue doesn't grow)", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      const body = prBody();
      const makeReq = () =>
        new Request("http://localhost/webhook/github", {
          method: "POST",
          body,
          headers: {
            "x-hub-signature-256": sign(body, SECRET),
            "x-github-event": "pull_request",
            "x-github-delivery": "same-id",
          },
        });
      const first = await webhookRoute({ req: makeReq(), store, runtime, secret: SECRET });
      expect(first.status).toBe(200);
      expect(runtime.webhookQueue).toHaveLength(1);

      const second = await webhookRoute({ req: makeReq(), store, runtime, secret: SECRET });
      expect(second.status).toBe(200);
      expect(await second.text()).toBe("duplicate");
      expect(runtime.webhookQueue).toHaveLength(1); // NOT doubled
      store.close();
    } finally {
      cleanup();
    }
  });

  test("ping event signs correctly but is ignored (200, not enqueued)", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      const body = JSON.stringify({ zen: "Design for failure." });
      const req = new Request("http://localhost/webhook/github", {
        method: "POST",
        body,
        headers: {
          "x-hub-signature-256": sign(body, SECRET),
          "x-github-event": "ping",
          "x-github-delivery": "ping-0001",
        },
      });
      const res = await webhookRoute({ req, store, runtime, secret: SECRET });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ignored");
      expect(runtime.webhookQueue).toHaveLength(0);
      store.close();
    } finally {
      cleanup();
    }
  });

  test("pull_request.closed is ignored (we don't re-review on close)", async () => {
    const { path, cleanup } = tmpDb();
    try {
      const store = openStore(path);
      const runtime = makeRuntime();
      const body = prBody({ action: "closed" });
      const req = new Request("http://localhost/webhook/github", {
        method: "POST",
        body,
        headers: {
          "x-hub-signature-256": sign(body, SECRET),
          "x-github-event": "pull_request",
          "x-github-delivery": "closed-0001",
        },
      });
      const res = await webhookRoute({ req, store, runtime, secret: SECRET });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ignored");
      expect(runtime.webhookQueue).toHaveLength(0);
      store.close();
    } finally {
      cleanup();
    }
  });
});
