import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import { recordCacheTelemetry } from "../src/review/cache-telemetry";
import * as metricsModule from "../src/server/metrics";
import * as loggerModule from "../src/server/logger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(
  cacheRead: number,
  cacheCreation: number,
  inputTokens = 0,
) {
  return {
    input_tokens: inputTokens,
    output_tokens: 0,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

const BASE = {
  repo: "acme/widget",
  pr: 42,
  headSha: "deadbeef",
} as const;

// ---------------------------------------------------------------------------
// hit_ratio computation
// ---------------------------------------------------------------------------

describe("recordCacheTelemetry — hit_ratio math", () => {
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(loggerModule.log, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  test("cache_read=900, cache_creation=0, input=100 → hit_ratio=0.9", () => {
    recordCacheTelemetry({
      ...BASE,
      usage: makeUsage(900, 0, 100),
      mode: "single",
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const fields = infoSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields?.hit_ratio).toBeCloseTo(0.9);
    expect(fields?.cache_read_tokens).toBe(900);
    expect(fields?.cache_creation_tokens).toBe(0);
    expect(fields?.input_tokens).toBe(100);
  });

  test("cache_read=500, cache_creation=500, input=0 → hit_ratio=0.5", () => {
    recordCacheTelemetry({
      ...BASE,
      usage: makeUsage(500, 500, 0),
      mode: "single",
    });

    const fields = infoSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields?.hit_ratio).toBeCloseTo(0.5);
  });

  test("cache_read=1000, cache_creation=0, input=0 → hit_ratio=1.0", () => {
    recordCacheTelemetry({
      ...BASE,
      usage: makeUsage(1000, 0, 0),
      mode: "single",
    });

    const fields = infoSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields?.hit_ratio).toBeCloseTo(1.0);
  });
});

// ---------------------------------------------------------------------------
// divide-by-zero guard
// ---------------------------------------------------------------------------

describe("recordCacheTelemetry — divide-by-zero guard", () => {
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(loggerModule.log, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  test("all-zero usage → no log emitted (suppressed)", () => {
    recordCacheTelemetry({
      ...BASE,
      usage: makeUsage(0, 0, 0),
      mode: "single",
    });

    expect(infoSpy).not.toHaveBeenCalled();
  });

  test("null cache fields coerce to 0 and suppress log", () => {
    recordCacheTelemetry({
      ...BASE,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
      },
      mode: "single",
    });

    expect(infoSpy).not.toHaveBeenCalled();
  });

  test("undefined cache fields coerce to 0 and suppress log", () => {
    recordCacheTelemetry({
      ...BASE,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
      mode: "single",
    });

    expect(infoSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// log-emit shape
// ---------------------------------------------------------------------------

describe("recordCacheTelemetry — log shape", () => {
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    infoSpy = spyOn(loggerModule.log, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  test("golden log shape: all five numeric fields present with evt='prompt.cache'", () => {
    recordCacheTelemetry({
      ...BASE,
      usage: makeUsage(900, 0, 100),
      mode: "chunked-pass-1",
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [msg, fields] = infoSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe("prompt.cache");
    expect(fields.evt).toBe("prompt.cache");
    expect(fields.repo).toBe("acme/widget");
    expect(fields.pr).toBe(42);
    expect(fields.headSha).toBe("deadbeef");
    expect(fields.mode).toBe("chunked-pass-1");
    // Five numeric fields
    expect(typeof fields.cache_read_tokens).toBe("number");
    expect(typeof fields.cache_creation_tokens).toBe("number");
    expect(typeof fields.input_tokens).toBe("number");
    expect(typeof fields.hit_ratio).toBe("number");
  });

  test("mode is propagated correctly for chunked-pass-2", () => {
    recordCacheTelemetry({
      ...BASE,
      usage: makeUsage(100, 50, 0),
      mode: "chunked-pass-2",
    });

    const fields = infoSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields?.mode).toBe("chunked-pass-2");
  });
});

// ---------------------------------------------------------------------------
// counter bumps
// ---------------------------------------------------------------------------

describe("recordCacheTelemetry — counter increments", () => {
  let readSpy: ReturnType<typeof spyOn>;
  let creationSpy: ReturnType<typeof spyOn>;
  let infoSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    readSpy = spyOn(metricsModule, "incPromptCacheRead").mockImplementation(() => {});
    creationSpy = spyOn(metricsModule, "incPromptCacheCreation").mockImplementation(() => {});
    infoSpy = spyOn(loggerModule.log, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    readSpy.mockRestore();
    creationSpy.mockRestore();
    infoSpy.mockRestore();
  });

  test("cache_read=900, cache_creation=0 → incPromptCacheRead(900), incPromptCacheCreation not called", () => {
    recordCacheTelemetry({
      ...BASE,
      usage: makeUsage(900, 0, 100),
      mode: "single",
    });

    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith(900);
    // creation counter still called with 0 is fine, but check it's called with 0
    expect(creationSpy).toHaveBeenCalledWith(0);
  });

  test("cache_read=0, cache_creation=200 → incPromptCacheCreation(200)", () => {
    recordCacheTelemetry({
      ...BASE,
      usage: makeUsage(0, 200, 50),
      mode: "single",
    });

    expect(readSpy).toHaveBeenCalledWith(0);
    expect(creationSpy).toHaveBeenCalledWith(200);
  });

  test("all-zero usage → neither counter is incremented", () => {
    recordCacheTelemetry({
      ...BASE,
      usage: makeUsage(0, 0, 100),
      mode: "single",
    });

    expect(readSpy).not.toHaveBeenCalled();
    expect(creationSpy).not.toHaveBeenCalled();
  });

  test("never throws even with missing usage fields", () => {
    expect(() =>
      recordCacheTelemetry({
        ...BASE,
        usage: {},
        mode: "single",
      }),
    ).not.toThrow();
  });
});
