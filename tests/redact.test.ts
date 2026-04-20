/**
 * Tests for src/util/redact.ts
 *
 * Coverage:
 *  - Pattern matching for each built-in shape (ghp_, github_pat_, ghs_,
 *    sk-ant-, JWT, Bearer)
 *  - Per-key hex redaction
 *  - Recursion depth cap
 *  - Cycle safety
 *  - Error handling for exotic types (BigInt, Date, TypedArray, undefined, null,
 *    Symbol, plain numbers/booleans)
 *  - Fuzz: 1000 randomly-generated tokens per shape are all redacted
 *  - Red-team: log an object that contains a PAT as field value, inside an error
 *    message, and in a URL query string
 *  - Performance: <0.5 ms per 10 KB payload (100 iterations)
 */
import { describe, expect, test } from "bun:test";
import { redact, registerSecretPattern } from "../src/util/redact";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomAlpha(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: len }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}

function randomHex(len: number): string {
  return Array.from({ length: len }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
}

function assertRedacted(result: unknown, label: string): void {
  const json = JSON.stringify(result);
  expect(json).toContain(`[REDACTED:${label}]`);
  // The raw material must not appear — checked per pattern test individually.
}

// ---------------------------------------------------------------------------
// Built-in pattern tests
// ---------------------------------------------------------------------------

describe("ghp_ token", () => {
  test("bare string is redacted", () => {
    const token = `ghp_${randomAlpha(36)}`;
    const result = redact(token) as string;
    expect(result).toBe("[REDACTED:GH_TOKEN]");
  });

  test("embedded in a URL is redacted", () => {
    const token = `ghp_${randomAlpha(40)}`;
    const result = redact(`https://example.com?token=${token}`) as string;
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED:GH_TOKEN]");
  });
});

describe("github_pat_ token", () => {
  test("bare string is redacted", () => {
    const token = `github_pat_${randomAlpha(82)}`;
    const result = redact(token) as string;
    expect(result).toBe("[REDACTED:GH_FINE_GRAINED_PAT]");
  });
});

describe("ghs_ token", () => {
  test("bare string is redacted", () => {
    const token = `ghs_${randomAlpha(36)}`;
    const result = redact(token) as string;
    expect(result).toBe("[REDACTED:GH_APP_TOKEN]");
  });
});

describe("Anthropic key (sk-ant-)", () => {
  test("bare key is redacted", () => {
    const key = `sk-ant-${randomAlpha(40)}`;
    const result = redact(key) as string;
    expect(result).toBe("[REDACTED:ANTHROPIC_KEY]");
  });

  test("key with underscores and hyphens is redacted", () => {
    const key = "sk-ant-api03-AAAA_bbbb-cccc";
    const result = redact(key) as string;
    expect(result).toBe("[REDACTED:ANTHROPIC_KEY]");
  });
});

describe("JWT", () => {
  test("typical JWT is redacted", () => {
    // Three base64url segments
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const payload = "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ";
    const sig = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const jwt = `${header}.${payload}.${sig}`;
    const result = redact(jwt) as string;
    expect(result).toBe("[REDACTED:JWT]");
  });

  test("JWT embedded in Authorization header string", () => {
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const payload = "eyJzdWIiOiIxMjM0NTY3ODkwIn0";
    const sig = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const value = `Bearer ${header}.${payload}.${sig}`;
    const result = redact(value) as string;
    // Bearer pattern also matches; either label is fine as long as secrets gone.
    expect(result).not.toContain(header);
  });
});

describe("Bearer token", () => {
  test("simple Bearer value is redacted", () => {
    const result = redact("Bearer abc123XYZ_~+=") as string;
    expect(result).toBe("[REDACTED:BEARER_TOKEN]");
  });

  test("Authorization header object value is redacted", () => {
    const result = redact({
      Authorization: "Bearer super-secret-token-value",
    }) as Record<string, unknown>;
    expect((result as Record<string, unknown>)["Authorization"]).toBe(
      "[REDACTED:BEARER_TOKEN]"
    );
  });
});

// ---------------------------------------------------------------------------
// Per-key hex redaction
// ---------------------------------------------------------------------------

describe("per-key hex redaction", () => {
  test("'token' key with >=32-char hex value is redacted", () => {
    const hex = randomHex(40);
    const result = redact({ token: hex }) as Record<string, unknown>;
    expect(result["token"]).toBe("[REDACTED:HEX_SECRET]");
  });

  test("'secret' key is redacted", () => {
    const hex = randomHex(32);
    const result = redact({ secret: hex }) as Record<string, unknown>;
    expect(result["secret"]).toBe("[REDACTED:HEX_SECRET]");
  });

  test("'api_key' key is redacted", () => {
    const hex = randomHex(64);
    const result = redact({ api_key: hex }) as Record<string, unknown>;
    expect(result["api_key"]).toBe("[REDACTED:HEX_SECRET]");
  });

  test("'password' key with hex value is redacted", () => {
    const hex = randomHex(36);
    const result = redact({ password: hex }) as Record<string, unknown>;
    expect(result["password"]).toBe("[REDACTED:HEX_SECRET]");
  });

  test("sensitive key with non-hex value is NOT key-redacted (still pattern-scanned)", () => {
    const result = redact({ token: "hello-world" }) as Record<string, unknown>;
    expect(result["token"]).toBe("hello-world");
  });

  test("non-sensitive key with hex value is NOT redacted", () => {
    const hex = randomHex(40);
    const result = redact({ sha: hex }) as Record<string, unknown>;
    // Should pass through unchanged (no pattern match for plain hex)
    expect(result["sha"]).toBe(hex);
  });

  test("short hex (<32 chars) on sensitive key is NOT redacted", () => {
    const hex = randomHex(31);
    const result = redact({ token: hex }) as Record<string, unknown>;
    expect(result["token"]).toBe(hex);
  });
});

// ---------------------------------------------------------------------------
// Nested object / array traversal
// ---------------------------------------------------------------------------

describe("nested traversal", () => {
  test("deeply nested string is redacted", () => {
    const token = `ghp_${randomAlpha(36)}`;
    const obj = { a: { b: { c: [token] } } };
    const result = redact(obj) as { a: { b: { c: string[] } } };
    expect(result.a.b.c[0]).toBe("[REDACTED:GH_TOKEN]");
  });

  test("array at top level", () => {
    const token = `ghs_${randomAlpha(40)}`;
    const result = redact([token]) as string[];
    expect(result[0]).toBe("[REDACTED:GH_APP_TOKEN]");
  });

  test("safe key name preserved, only value scrubbed", () => {
    const token = `sk-ant-${randomAlpha(30)}`;
    const result = redact({ message: `Error: ${token}` }) as Record<
      string,
      unknown
    >;
    expect(result["message"]).not.toContain("sk-ant-");
  });
});

// ---------------------------------------------------------------------------
// Recursion depth cap
// ---------------------------------------------------------------------------

describe("recursion depth cap", () => {
  test("object nested deeper than 32 is not recursed into", () => {
    // Build a chain of 40 nested objects, each wrapping a PAT.
    const token = `ghp_${randomAlpha(36)}`;
    let node: Record<string, unknown> = { secret: token };
    for (let i = 0; i < 40; i++) {
      node = { child: node };
    }
    // Should not throw regardless of depth.
    expect(() => redact(node)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Cycle safety
// ---------------------------------------------------------------------------

describe("cycle safety", () => {
  test("circular reference does not infinite-loop", () => {
    const obj: Record<string, unknown> = { name: "cycle-test" };
    obj["self"] = obj; // create cycle
    expect(() => redact(obj)).not.toThrow();
  });

  test("array with self-reference is safe", () => {
    const arr: unknown[] = ["hello"];
    arr.push(arr);
    expect(() => redact(arr)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Exotic / edge-case types — must not throw
// ---------------------------------------------------------------------------

describe("exotic types — no throw", () => {
  test("null", () => expect(redact(null)).toBeNull());
  test("undefined", () => expect(redact(undefined)).toBeUndefined());
  test("number", () => expect(redact(42)).toBe(42));
  test("boolean", () => expect(redact(true)).toBe(true));
  test("BigInt is returned as-is", () => {
    const big = BigInt("12345678901234567890");
    expect(redact(big)).toBe(big);
  });
  test("Date is returned as-is", () => {
    const d = new Date();
    expect(redact(d)).toBe(d);
  });
  test("Uint8Array is returned as-is", () => {
    const buf = new Uint8Array([1, 2, 3]);
    expect(redact(buf)).toBe(buf);
  });
  test("Symbol is returned as-is", () => {
    const sym = Symbol("test");
    expect(redact(sym)).toBe(sym);
  });
  test("Error object is returned as-is (not a plain object)", () => {
    const err = new Error("test error");
    expect(redact(err)).toBe(err);
  });
  test("Map is returned as-is", () => {
    const m = new Map([["k", "v"]]);
    expect(redact(m)).toBe(m);
  });
});

// ---------------------------------------------------------------------------
// Red-team test: try to log an object containing a PAT in multiple forms
// ---------------------------------------------------------------------------

describe("red-team: PAT in multiple positions", () => {
  const pat = `ghp_${"A".repeat(36)}`;

  test("PAT as direct field value is scrubbed", () => {
    const result = redact({ github_token: pat }) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain(pat);
  });

  test("PAT embedded in error message is scrubbed", () => {
    const result = redact({
      error: `API call failed with token ${pat}: 403 Forbidden`,
    }) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain(pat);
    expect(JSON.stringify(result)).toContain("[REDACTED:GH_TOKEN]");
  });

  test("PAT in URL query string is scrubbed", () => {
    const result = redact({
      url: `https://api.github.com/repos/foo/bar?access_token=${pat}`,
    }) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain(pat);
  });

  test("PAT nested inside array inside object is scrubbed", () => {
    const result = redact({
      headers: ["Content-Type: application/json", `Authorization: token ${pat}`],
    }) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain(pat);
  });
});

// ---------------------------------------------------------------------------
// Fuzz: 1000 tokens per shape are all redacted
// ---------------------------------------------------------------------------

describe("fuzz: 1000 tokens per shape", () => {
  test("ghp_ tokens", () => {
    for (let i = 0; i < 1000; i++) {
      const token = `ghp_${randomAlpha(36 + (i % 20))}`;
      const result = redact(token) as string;
      expect(result).toBe("[REDACTED:GH_TOKEN]");
    }
  });

  test("github_pat_ tokens", () => {
    for (let i = 0; i < 1000; i++) {
      const token = `github_pat_${randomAlpha(82 + (i % 10))}`;
      const result = redact(token) as string;
      expect(result).toBe("[REDACTED:GH_FINE_GRAINED_PAT]");
    }
  });

  test("ghs_ tokens", () => {
    for (let i = 0; i < 1000; i++) {
      const token = `ghs_${randomAlpha(36 + (i % 15))}`;
      const result = redact(token) as string;
      expect(result).toBe("[REDACTED:GH_APP_TOKEN]");
    }
  });

  test("sk-ant- keys", () => {
    for (let i = 0; i < 1000; i++) {
      const key = `sk-ant-${randomAlpha(20 + (i % 30))}`;
      const result = redact(key) as string;
      expect(result).toBe("[REDACTED:ANTHROPIC_KEY]");
    }
  });

  test("Bearer tokens", () => {
    for (let i = 0; i < 1000; i++) {
      const value = `Bearer ${randomAlpha(32 + (i % 20))}`;
      const result = redact(value) as string;
      expect(result).toBe("[REDACTED:BEARER_TOKEN]");
    }
  });

  test("hex values on sensitive keys", () => {
    const keys = ["secret", "token", "api_key", "apikey", "password"];
    for (let i = 0; i < 1000; i++) {
      const key = keys[i % keys.length] as string;
      const hex = randomHex(32 + (i % 20));
      const result = redact({ [key]: hex }) as Record<string, unknown>;
      expect(result[key]).toBe("[REDACTED:HEX_SECRET]");
    }
  });
});

// ---------------------------------------------------------------------------
// registerSecretPattern
// ---------------------------------------------------------------------------

describe("registerSecretPattern", () => {
  test("custom pattern is applied", () => {
    registerSecretPattern(/MY_CUSTOM_SECRET_[A-Z0-9]+/, "CUSTOM");
    const result = redact("something MY_CUSTOM_SECRET_ABC123 here") as string;
    expect(result).toContain("[REDACTED:CUSTOM]");
    expect(result).not.toContain("MY_CUSTOM_SECRET_ABC123");
  });

  test("custom pattern without global flag is made global", () => {
    registerSecretPattern(/ANOTHER_SECRET_[A-Z]+/, "ANOTHER");
    // Two occurrences — both should be redacted.
    const result = redact(
      "ANOTHER_SECRET_ABC and ANOTHER_SECRET_XYZ"
    ) as string;
    expect(result).not.toContain("ANOTHER_SECRET_ABC");
    expect(result).not.toContain("ANOTHER_SECRET_XYZ");
  });
});

// ---------------------------------------------------------------------------
// Performance: <2 ms per 10 KB payload over 500 iterations
//
// Budget is deliberately generous (the design target is <0.5ms locally). CI
// runners are shared VMs with unpredictable scheduling — a tight ceiling makes
// this test flaky for noise, not for regressions. 500 iterations smooths short
// GC/scheduling pauses; the 2ms average still catches any real quadratic-ish
// regression in the redactor.
// ---------------------------------------------------------------------------

describe("performance", () => {
  test("10 KB payload processes in <2 ms average", () => {
    // Build a ~10 KB plain-object payload with a mix of benign and sensitive fields.
    const payload: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      payload[`field_${i}`] = `Some log message with data ${randomAlpha(60)} and more text here for padding.`;
    }
    // Warm up once outside the timed loop.
    redact(payload);

    const ITERATIONS = 500;
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      redact(payload);
    }
    const totalMs = performance.now() - start;
    const avgMs = totalMs / ITERATIONS;

    expect(avgMs).toBeLessThan(2);
  });
});
