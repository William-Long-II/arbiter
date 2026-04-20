/**
 * Secret redactor for structured log payloads.
 *
 * Walk any unknown value recursively and replace secret-looking strings with
 * [REDACTED:<label>].  Two mechanisms:
 *   1. Pattern-based: regex applied to every string value (and to each segment
 *      of URLs / error messages nested arbitrarily deep).
 *   2. Key-based: when a plain-object key matches /secret|token|api_?key|password/i
 *      and the value is a hex string of >=32 chars, the value is redacted.
 *
 * Safety limits
 *   - Recursion depth is capped at MAX_DEPTH (32).
 *   - Cycles are detected via a WeakSet so circular refs don't infinite-loop.
 *   - Any exotic value (BigInt, Date, TypedArray, undefined, symbol, …) is
 *     returned as-is; the function never throws.
 */

const MAX_DEPTH = 32;

/** Each entry is [compiled regex, label used in the replacement string]. */
const patterns: Array<[RegExp, string]> = [
  [/ghp_[A-Za-z0-9]{36,}/g, "GH_TOKEN"],
  [/github_pat_[A-Za-z0-9_]{82,}/g, "GH_FINE_GRAINED_PAT"],
  [/ghs_[A-Za-z0-9]{36,}/g, "GH_APP_TOKEN"],
  [/sk-ant-[A-Za-z0-9_-]+/g, "ANTHROPIC_KEY"],
  // JWT: three base64url segments separated by dots
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "JWT"],
  // Authorization header value (Bearer …)
  [/Bearer\s+[A-Za-z0-9._~+/\-]+=*/g, "BEARER_TOKEN"],
];

/** Key pattern for per-key hex redaction. */
const SENSITIVE_KEY = /secret|token|api_?key|password/i;
/** Hex string of at least 32 chars (git SHAs are 40, so this will match those
 *  too when on a sensitive key — see Concerns in the PR body). */
const HEX_VALUE = /^[0-9a-f]{32,}$/i;

/** Allow callers / future operators to register additional patterns at runtime. */
export function registerSecretPattern(regex: RegExp, label: string): void {
  // Clone with global flag so repeated exec() calls across strings work correctly.
  const global = regex.flags.includes("g")
    ? regex
    : new RegExp(regex.source, regex.flags + "g");
  patterns.push([global, label]);
}

/** Apply all registered patterns to a single string. */
function scrubString(s: string): string {
  let out = s;
  for (const [re, label] of patterns) {
    // Reset lastIndex; the regex is reused across calls and is global.
    re.lastIndex = 0;
    out = out.replace(re, `[REDACTED:${label}]`);
  }
  return out;
}

/**
 * Recursively redact secrets from an arbitrary value.
 * Returns a new value (objects/arrays are shallow-cloned at each level).
 */
export function redact(value: unknown): unknown {
  const visited = new WeakSet<object>();
  return walk(value, 0, visited);
}

function walk(value: unknown, depth: number, visited: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return value;

  if (value === null || value === undefined) return value;

  if (typeof value === "string") return scrubString(value);

  // Leave numbers, booleans, BigInt, symbols untouched.
  if (typeof value !== "object") return value;

  // Cycle guard — only works for object types.
  if (visited.has(value as object)) return value;
  visited.add(value as object);

  // Arrays: walk each element.
  if (Array.isArray(value)) {
    return value.map((el) => walk(el, depth + 1, visited));
  }

  // TypedArrays, Dates, Errors, Maps, Sets, etc. — do not iterate; return as-is.
  // We only recurse into plain-object instances to avoid breaking class instances.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const raw = obj[key];
    // Per-key hex redaction: sensitive key + hex value >= 32 chars.
    if (
      SENSITIVE_KEY.test(key) &&
      typeof raw === "string" &&
      HEX_VALUE.test(raw)
    ) {
      result[key] = "[REDACTED:HEX_SECRET]";
    } else {
      result[key] = walk(raw, depth + 1, visited);
    }
  }
  return result;
}
