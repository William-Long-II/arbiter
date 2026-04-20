/**
 * Tests for per-repo Anthropic key override via env-var indirection.
 *
 * The value stored in repos.yaml is the env-var *name* (safe to commit),
 * not the API key itself.  resolveAnthropicClient resolves the name to a
 * value at request time and constructs a fresh client only when needed.
 */
import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import AnthropicSDK from "@anthropic-ai/sdk";
import { resolveAnthropicClient } from "../src/review/client";
import * as logger from "../src/server/logger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefaultClient(): AnthropicSDK {
  // Cast so we don't need a real API key for unit tests.
  return new AnthropicSDK({ apiKey: "default-key" }) as AnthropicSDK;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("resolveAnthropicClient", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Snapshot env vars we might touch so afterEach can restore exactly.
    originalEnv = {
      WIDGET_ANTHROPIC_KEY: process.env["WIDGET_ANTHROPIC_KEY"],
      ACME_ANTHROPIC_KEY: process.env["ACME_ANTHROPIC_KEY"],
    };
  });

  afterEach(() => {
    // Restore env vars.
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  });

  // AC 1 — override configured + env var set → fresh client with that key
  test("override set + env set → returns new client (not the default)", () => {
    process.env["WIDGET_ANTHROPIC_KEY"] = "sk-per-repo-key-abc";
    const defaultClient = makeDefaultClient();
    const constructorSpy = spyOn(AnthropicSDK.prototype, "constructor" as never);

    const result = resolveAnthropicClient(
      { anthropic_api_key_env: "WIDGET_ANTHROPIC_KEY" },
      defaultClient,
    );

    // The returned instance must be a different object from the default.
    expect(result).not.toBe(defaultClient);
    // It should still be an Anthropic instance.
    expect(result).toBeInstanceOf(AnthropicSDK);

    constructorSpy.mockRestore();
  });

  // AC 2 — override configured + env var unset → default client + warn log
  test("override set + env missing → default client + warn log", () => {
    delete process.env["WIDGET_ANTHROPIC_KEY"];
    const defaultClient = makeDefaultClient();
    const warnSpy = spyOn(logger.log, "warn").mockImplementation(() => {});

    const result = resolveAnthropicClient(
      { anthropic_api_key_env: "WIDGET_ANTHROPIC_KEY" },
      defaultClient,
    );

    expect(result).toBe(defaultClient);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [, fields] = warnSpy.mock.calls[0]!;
    expect((fields as Record<string, unknown>)["evt"]).toBe("anthropic.override_missing");
    expect((fields as Record<string, unknown>)["env_var_name"]).toBe("WIDGET_ANTHROPIC_KEY");

    warnSpy.mockRestore();
  });

  // AC 3 — override not configured → default client, no logging
  test("override unset → default client, no warn or debug emitted", () => {
    const defaultClient = makeDefaultClient();
    const warnSpy = spyOn(logger.log, "warn").mockImplementation(() => {});
    const debugSpy = spyOn(logger.log, "debug").mockImplementation(() => {});

    const result = resolveAnthropicClient(undefined, defaultClient);

    expect(result).toBe(defaultClient);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  // AC 4 — two repos with distinct override env vars → two distinct clients
  test("two repos with different env vars → distinct client instances", () => {
    process.env["WIDGET_ANTHROPIC_KEY"] = "sk-widget-key";
    process.env["ACME_ANTHROPIC_KEY"] = "sk-acme-key";
    const defaultClient = makeDefaultClient();

    const clientA = resolveAnthropicClient(
      { anthropic_api_key_env: "WIDGET_ANTHROPIC_KEY" },
      defaultClient,
    );
    const clientB = resolveAnthropicClient(
      { anthropic_api_key_env: "ACME_ANTHROPIC_KEY" },
      defaultClient,
    );

    expect(clientA).not.toBe(defaultClient);
    expect(clientB).not.toBe(defaultClient);
    // The two repos get distinct client instances.
    expect(clientA).not.toBe(clientB);
    expect(clientA).toBeInstanceOf(AnthropicSDK);
    expect(clientB).toBeInstanceOf(AnthropicSDK);
  });

  // AC 5 — debug log emitted when override is used successfully
  test("override set + env set → debug log with correct fields", () => {
    process.env["WIDGET_ANTHROPIC_KEY"] = "sk-some-key";
    const defaultClient = makeDefaultClient();
    const debugSpy = spyOn(logger.log, "debug").mockImplementation(() => {});

    resolveAnthropicClient(
      { anthropic_api_key_env: "WIDGET_ANTHROPIC_KEY" },
      defaultClient,
    );

    expect(debugSpy).toHaveBeenCalledTimes(1);
    const [, fields] = debugSpy.mock.calls[0]!;
    expect((fields as Record<string, unknown>)["evt"]).toBe("anthropic.override");
    expect((fields as Record<string, unknown>)["env_var_name"]).toBe("WIDGET_ANTHROPIC_KEY");

    debugSpy.mockRestore();
  });

  // AC 6 — empty string env var treated as missing (falsy guard)
  test("env var set to empty string is treated as missing → default + warn", () => {
    process.env["WIDGET_ANTHROPIC_KEY"] = "";
    const defaultClient = makeDefaultClient();
    const warnSpy = spyOn(logger.log, "warn").mockImplementation(() => {});

    const result = resolveAnthropicClient(
      { anthropic_api_key_env: "WIDGET_ANTHROPIC_KEY" },
      defaultClient,
    );

    expect(result).toBe(defaultClient);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  // AC 7 — reviewConfig with no anthropic_api_key_env field → default client
  test("reviewConfig present but no anthropic_api_key_env → default client", () => {
    const defaultClient = makeDefaultClient();
    const result = resolveAnthropicClient(
      { include_paths: ["src/**"], exclude_paths: [] },
      defaultClient,
    );
    expect(result).toBe(defaultClient);
  });

  // AC 8 — null reviewConfig → default client (same as no reviewConfig)
  test("null reviewConfig → default client", () => {
    const defaultClient = makeDefaultClient();
    const result = resolveAnthropicClient(null, defaultClient);
    expect(result).toBe(defaultClient);
  });
});
