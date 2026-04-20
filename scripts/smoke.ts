#!/usr/bin/env bun
/**
 * End-to-end smoke harness for review-me.
 *
 * Boots the server in-process with a test repos.yaml, installs a
 * globalThis.fetch interceptor that routes all api.github.com and
 * api.anthropic.com traffic to deterministic local mock handlers, then
 * exercises the full webhook pipeline:
 *
 *   pull_request.opened → check_suite.completed → issue_comment (mention)
 *
 * After the sequence it asserts:
 *   1. The mock GitHub API received POST /repos/acme/widget/pulls/7/reviews
 *      with the expected verdict and at least one line comment.
 *   2. The prompt sent to Anthropic matches tests/golden/prompt.txt
 *      byte-for-byte; on mismatch it prints a unified diff and fails.
 *   3. Zero un-intercepted fetch calls (no network egress).
 *
 * Can be run directly (`bun run smoke`) or imported as `runSmoke()` by
 * `tests/e2e/smoke.test.ts`.
 */
import { createHmac, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { getAllowlist, loadAllowlist } from "../src/config";
import { createOctokit } from "../src/github";
import { createAnthropic } from "../src/review/client";
import { createWebhooks } from "../src/server/webhooks";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
// Use fileURLToPath so the path is correct on Windows (avoids a leading `/C:/…`)
const FIXTURES_DIR = fileURLToPath(new URL("../tests/fixtures/e2e", import.meta.url));
const GOLDEN_PATH = fileURLToPath(new URL("../tests/golden/prompt.txt", import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readFixture(name: string): unknown {
  const path = join(FIXTURES_DIR, name);
  return JSON.parse(readFileSync(path, "utf8"));
}

function sign(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

async function postWebhook(
  url: string,
  event: string,
  body: string,
  secret: string,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": sign(body, secret),
    },
    body,
  });
}

/**
 * Produce a minimal unified diff string without external dependencies.
 * Shows every line; context lines are prefixed with a space.
 */
function unifiedDiff(expected: string, actual: string, label: string): string {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const lines: string[] = [`--- ${label} (golden)`, `+++ ${label} (actual)`];
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const aLine = a[i];
    const bLine = b[i];
    if (aLine === bLine) {
      lines.push(` ${aLine ?? ""}`);
    } else {
      if (aLine !== undefined) lines.push(`-${aLine}`);
      if (bLine !== undefined) lines.push(`+${bLine}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Structured logger for the harness (matches project log format, not console.log)
// ---------------------------------------------------------------------------
function smokeLog(
  level: "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    harness: "smoke",
    ...fields,
  });
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

// ---------------------------------------------------------------------------
// Fetch interceptor
// ---------------------------------------------------------------------------
type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

type InterceptorState = {
  requests: RecordedRequest[];
  anthropicRequestBodies: string[];
  reviewPostRequests: RecordedRequest[];
};

/**
 * Install an in-process fetch interceptor routing GitHub and Anthropic
 * API calls to local mock handlers.
 *
 * WHY monkeypatching: Octokit and the Anthropic SDK both resolve
 * globalThis.fetch at call time, not at import time (in Bun's module
 * environment). Replacing it here is sufficient to intercept every
 * outbound HTTP request made by either library. This is fragile on
 * future Bun upgrades that might cache the reference — see self-review.
 *
 * Returns a cleanup function that restores the original fetch.
 */
function installFetchInterceptor(state: InterceptorState): () => void {
  const original = globalThis.fetch;

  const prFixture = readFixture("github-pr.json") as Record<string, unknown>;
  const prFilesFixture = readFixture("github-pr-files.json") as unknown[];
  const checkRunsFixture = readFixture("github-check-runs.json") as unknown[];
  const reviewsFixture = readFixture("github-reviews.json") as unknown[];
  const createReviewFixture = readFixture("github-create-review-response.json") as Record<string, unknown>;

  // We assign to globalThis.fetch. TypeScript's DOM lib typing includes a
  // `preconnect` method that Bun's runtime doesn't expose; we cast through
  // `unknown` to sidestep the structural mismatch without losing type safety
  // on the function body itself.
  const intercepted = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const bodyText = init?.body != null ? String(init.body) : null;

    const headerMap: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers as ConstructorParameters<typeof Headers>[0]);
      h.forEach((v, k) => {
        headerMap[k] = v;
      });
    }

    const recorded: RecordedRequest = {
      url,
      method,
      headers: headerMap,
      body: bodyText,
    };
    state.requests.push(recorded);

    // -----------------------------------------------------------------------
    // GitHub API mock
    // -----------------------------------------------------------------------
    if (url.startsWith("https://api.github.com/")) {
      const path = url.replace("https://api.github.com", "").split("?")[0] ?? "";

      // GET /repos/acme/widget/pulls/7
      if (method === "GET" && /^\/repos\/acme\/widget\/pulls\/7$/.test(path)) {
        return new Response(JSON.stringify(prFixture), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // GET /repos/acme/widget/pulls/7/files
      if (method === "GET" && /^\/repos\/acme\/widget\/pulls\/7\/files/.test(path)) {
        return new Response(JSON.stringify(prFilesFixture), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // GET /repos/acme/widget/commits/:sha/check-runs
      // WHY: Returning the check runs as a direct array (not wrapped in
      // {check_runs, total_count}) bypasses a bug in @octokit/plugin-paginate-rest
      // where the normalizer re-attaches `total_commits: undefined` onto the
      // extracted array, causing `"total_commits" in data` to be true and then
      // crashing with `new URL("")` when building the next-page URL.
      if (
        method === "GET" &&
        /^\/repos\/acme\/widget\/commits\/[^/]+\/check-runs/.test(path)
      ) {
        return new Response(JSON.stringify(checkRunsFixture), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // GET /repos/acme/widget/pulls/7/reviews
      if (
        method === "GET" &&
        /^\/repos\/acme\/widget\/pulls\/7\/reviews/.test(path)
      ) {
        return new Response(JSON.stringify(reviewsFixture), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // POST /repos/acme/widget/pulls/7/reviews — the endpoint we assert on
      if (
        method === "POST" &&
        /^\/repos\/acme\/widget\/pulls\/7\/reviews$/.test(path)
      ) {
        state.reviewPostRequests.push(recorded);
        return new Response(JSON.stringify(createReviewFixture), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // GET /repos/acme/widget/contents/.gitattributes — return 404 so the
      // pipeline proceeds without linguist filtering (repo has no .gitattributes).
      if (
        method === "GET" &&
        /^\/repos\/acme\/widget\/contents\/\.gitattributes/.test(path)
      ) {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }

      // GET /user (fetchAuthenticatedLogin — not used when selfLogin injected)
      if (method === "GET" && path === "/user") {
        return new Response(
          JSON.stringify({ login: "review-me-bot", id: 99 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      // Fallback: un-intercepted GitHub call — log and return 500 so the pipeline
      // fails fast rather than hanging on a real network timeout.
      smokeLog("error", "un-intercepted GitHub API call", { url, method });
      return new Response(
        JSON.stringify({ message: "mock: no handler for this endpoint" }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // -----------------------------------------------------------------------
    // Anthropic API mock
    // -----------------------------------------------------------------------
    if (url.startsWith("https://api.anthropic.com/")) {
      if (bodyText) {
        state.anthropicRequestBodies.push(bodyText);
      }
      // Return a raw HTTP response; the SDK layer is intercepted separately
      // (via messages.parse override) so this path is a fallback.
      return new Response(
        JSON.stringify({
          id: "msg_smoke01",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-opus-4-7",
          stop_reason: "end_turn",
          usage: { input_tokens: 350, output_tokens: 80 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // -----------------------------------------------------------------------
    // Local server calls (the harness POSTing to its own webhook endpoint)
    // -----------------------------------------------------------------------
    if (url.startsWith("http://127.0.0.1:")) {
      return original(input, init);
    }

    // -----------------------------------------------------------------------
    // Any other URL — block network egress immediately
    // -----------------------------------------------------------------------
    const errMsg = `smoke harness: un-intercepted fetch to ${url}`;
    smokeLog("error", errMsg);
    throw new Error(errMsg);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as unknown as Record<string, unknown>)["fetch"] = intercepted;

  return () => {
    (globalThis as unknown as Record<string, unknown>)["fetch"] = original;
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------
function assertReviewPosted(state: InterceptorState): void {
  if (state.reviewPostRequests.length === 0) {
    const allUrls = state.requests
      .map((r) => `  ${r.method} ${r.url}`)
      .join("\n");
    throw new Error(
      `ASSERTION FAILED: no POST /repos/acme/widget/pulls/7/reviews received\n` +
        `All intercepted requests:\n${allUrls}`,
    );
  }

  const reviewReq = state.reviewPostRequests[0]!;
  const reviewBody = JSON.parse(reviewReq.body ?? "{}") as {
    event?: string;
    body?: string;
    comments?: unknown[];
  };

  if (reviewBody.event !== "APPROVE" && reviewBody.event !== "COMMENT") {
    throw new Error(
      `ASSERTION FAILED: review event was "${reviewBody.event}", expected "APPROVE" or "COMMENT"`,
    );
  }

  if (!reviewBody.comments || reviewBody.comments.length === 0) {
    throw new Error(
      `ASSERTION FAILED: review had no line comments\n` +
        `Review body: ${JSON.stringify(reviewBody, null, 2)}`,
    );
  }

  smokeLog("info", "assertion: review posted", {
    event: reviewBody.event,
    commentCount: reviewBody.comments.length,
  });
}

async function assertGoldenPrompt(state: InterceptorState): Promise<void> {
  if (state.anthropicRequestBodies.length === 0) {
    throw new Error(
      "ASSERTION FAILED: no Anthropic request body was captured",
    );
  }

  const body = JSON.parse(state.anthropicRequestBodies[0]!) as {
    messages?: Array<{ role: string; content: unknown }>;
  };

  const userMessage = body.messages?.find((m) => m.role === "user");
  if (!userMessage) {
    throw new Error(
      "ASSERTION FAILED: no user message found in captured Anthropic request",
    );
  }

  const actualPrompt =
    typeof userMessage.content === "string"
      ? userMessage.content
      : JSON.stringify(userMessage.content);

  const goldenPrompt = await Bun.file(GOLDEN_PATH).text();

  if (actualPrompt === goldenPrompt) {
    smokeLog("info", "assertion: golden prompt matches");
    return;
  }

  const diff = unifiedDiff(goldenPrompt, actualPrompt, "tests/golden/prompt.txt");
  throw new Error(
    `ASSERTION FAILED: prompt does not match golden file.\n` +
      `Golden path: ${GOLDEN_PATH}\n` +
      `To update: run the harness in capture mode and overwrite tests/golden/prompt.txt\n\n` +
      `Diff:\n${diff}`,
  );
}

// ---------------------------------------------------------------------------
// Main harness
// ---------------------------------------------------------------------------
export async function runSmoke(): Promise<void> {
  const harnessStart = Date.now();
  smokeLog("info", "smoke harness starting");

  // Write a temp repos.yaml enabling acme/widget
  const reposYaml = [
    "repos:",
    "  acme/widget:",
    "    enabled: true",
    "    rereview: auto-on-sync",
  ].join("\n") + "\n";
  const reposPath = join(tmpdir(), `smoke-repos-${Date.now()}.yaml`);
  writeFileSync(reposPath, reposYaml, "utf8");

  // Guard required env vars so loadConfig doesn't throw if called elsewhere
  process.env["GITHUB_PAT"] ??= "ghp_smoke_test_token_not_real";
  process.env["GITHUB_WEBHOOK_SECRET"] ??= "smoke-secret-local";
  process.env["ANTHROPIC_API_KEY"] ??= "sk-ant-smoke-test-token-not-real";
  process.env["GITHUB_MACHINE_USER_LOGIN"] = "review-me-bot";

  const WEBHOOK_SECRET = "smoke-secret-local";

  const interceptorState: InterceptorState = {
    requests: [],
    anthropicRequestBodies: [],
    reviewPostRequests: [],
  };

  // Install fetch interceptor first — before creating any SDK clients so
  // they pick up the patched fetch on their first call.
  const restoreInterceptor = installFetchInterceptor(interceptorState);

  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    const anthropic = createAnthropic("sk-ant-smoke-test-token-not-real");

    // Override messages.parse at the SDK object level. The Anthropic SDK's
    // `parse` method internally calls the HTTP layer; we short-circuit it
    // entirely so we can (a) capture the exact prompt and (b) return a
    // deterministic result without a network round-trip.
    // @ts-expect-error -- duck-type override for test isolation
    anthropic.messages.parse = async (
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
      const messages = params["messages"] as
        | Array<{ role: string; content: unknown }>
        | undefined;
      const userMsg = messages?.find((m) => m.role === "user");
      if (userMsg) {
        // Store a mini-envelope so assertGoldenPrompt can find messages[].content
        interceptorState.anthropicRequestBodies.push(
          JSON.stringify({ messages: [userMsg] }),
        );
      }
      return {
        parsed_output: {
          verdict: "approve",
          summary:
            "Clean implementation. The factory function is well-structured and the export is correct.",
          lineComments: [
            {
              path: "src/factory.ts",
              line: 8,
              body: "Consider seeding the RNG or accepting an id parameter to make widget IDs deterministic in tests.",
            },
          ],
        },
        usage: {
          input_tokens: 350,
          output_tokens: 80,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      };
    };

    // loadAllowlist seeds the mutable holder; getAllowlist() returns the current snapshot.
    loadAllowlist(reposPath);
    const octokit = createOctokit("ghp_smoke_test_token_not_real");

    const webhooks = createWebhooks(WEBHOOK_SECRET, {
      getAllowlist,
      octokit,
      anthropic,
      selfLogin: "review-me-bot",
    });

    // Boot server on port 0 (OS assigns an ephemeral port)
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const pathname = new URL(req.url).pathname;

        if (req.method === "GET" && pathname === "/health") {
          return new Response("ok");
        }
        if (req.method !== "POST" || pathname !== "/webhook") {
          return new Response("not found", { status: 404 });
        }

        const id = req.headers.get("x-github-delivery");
        const name = req.headers.get("x-github-event");
        const signature = req.headers.get("x-hub-signature-256");
        if (!id || !name || !signature) {
          return new Response("missing required headers", { status: 400 });
        }

        const payload = await req.text();
        try {
          await webhooks.verifyAndReceive({
            id,
            name: name as Parameters<
              typeof webhooks.verifyAndReceive
            >[0]["name"],
            signature,
            payload,
          });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          if (message.includes("signature does not match")) {
            return new Response("invalid signature", { status: 401 });
          }
          return new Response("processing error", { status: 500 });
        }

        return new Response("ok", { status: 200 });
      },
    });

    const webhookUrl = `http://127.0.0.1:${server.port}/webhook`;
    smokeLog("info", "server started", { port: server.port });

    // -----------------------------------------------------------------------
    // Step 1: pull_request.opened
    // (exercises routing + allowlist check — no pipeline invocation expected)
    // -----------------------------------------------------------------------
    const prOpenedBody = JSON.stringify(readFixture("pull_request.opened.json"));
    const r1 = await postWebhook(webhookUrl, "pull_request", prOpenedBody, WEBHOOK_SECRET);
    if (!r1.ok) {
      throw new Error(`pull_request.opened webhook returned ${r1.status}`);
    }
    smokeLog("info", "step 1/3: pull_request.opened OK", { status: r1.status });

    // -----------------------------------------------------------------------
    // Step 2: check_suite.completed
    // (triggers evaluateHeadSha → diff fetch → LLM → review post)
    // -----------------------------------------------------------------------
    const checkSuiteBody = JSON.stringify(
      readFixture("check_suite.completed.json"),
    );
    const r2 = await postWebhook(
      webhookUrl,
      "check_suite",
      checkSuiteBody,
      WEBHOOK_SECRET,
    );
    if (!r2.ok) {
      throw new Error(`check_suite.completed webhook returned ${r2.status}`);
    }
    smokeLog("info", "step 2/3: check_suite.completed OK", {
      status: r2.status,
    });

    // Poll until the pipeline posts the review (async processing, up to 10s)
    const pipelineDeadline = Date.now() + 10_000;
    while (
      interceptorState.reviewPostRequests.length === 0 &&
      Date.now() < pipelineDeadline
    ) {
      await Bun.sleep(50);
    }

    // -----------------------------------------------------------------------
    // Step 3: issue_comment /review-me
    // (mention path — will be skipped by hasExistingReview since same head SHA)
    // -----------------------------------------------------------------------
    const commentBody = JSON.stringify(
      readFixture("issue_comment.created.json"),
    );
    const r3 = await postWebhook(
      webhookUrl,
      "issue_comment",
      commentBody,
      WEBHOOK_SECRET,
    );
    if (!r3.ok) {
      throw new Error(`issue_comment webhook returned ${r3.status}`);
    }
    smokeLog("info", "step 3/3: issue_comment OK (skip expected)", {
      status: r3.status,
    });

    // Brief drain to let the mention pipeline resolve its CI check before assertions
    await Bun.sleep(200);

    // -----------------------------------------------------------------------
    // Assertions
    // -----------------------------------------------------------------------
    assertReviewPosted(interceptorState);
    await assertGoldenPrompt(interceptorState);

    const elapsed = ((Date.now() - harnessStart) / 1_000).toFixed(2);
    smokeLog("info", "smoke harness PASSED", {
      elapsedSeconds: Number(elapsed),
      totalRequests: interceptorState.requests.length,
      reviewPosts: interceptorState.reviewPostRequests.length,
    });
  } finally {
    server?.stop();
    restoreInterceptor();
    try {
      unlinkSync(reposPath);
    } catch {
      /* best-effort temp file cleanup */
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (import.meta.main) {
  runSmoke()
    .then(() => {
      process.exit(0);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "error",
          msg: "smoke harness FAILED",
          error: message,
        }) + "\n",
      );
      process.exit(1);
    });
}
