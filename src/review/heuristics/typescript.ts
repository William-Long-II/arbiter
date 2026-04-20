import type { Heuristic } from "./index";

/**
 * TypeScript/JavaScript-specific review hints.
 *
 * These are text-level pointers for the LLM reviewer, not static-analysis
 * rules. The prompt instructs the LLM to look for these patterns; it should
 * stay silent when they are absent rather than manufacturing false positives.
 */
export const HEURISTICS: Heuristic[] = [
  {
    id: "ts/unhandled-promise",
    summary: "Unhandled promise rejection",
    hint: "Check for `async` functions whose return value is never `await`ed or `.catch()`ed (floating promises). A fire-and-forget call that rejects silently can crash the Node process or lose errors.",
  },
  {
    id: "ts/any-in-exports",
    summary: "`any` in new exported signatures",
    hint: "Look for `any` in newly added exported function parameters or return types. Using `any` in a public API defeats TypeScript's type-safety guarantee for all callers and is rarely intentional.",
  },
  {
    id: "ts/non-null-assertion-external",
    summary: "Non-null assertion (`!`) on externally sourced data",
    hint: "Review `!` assertions applied to values that come from API responses, environment variables, or user input. These are the exact cases where `null`/`undefined` can legitimately occur at runtime.",
  },
  {
    id: "ts/unsafe-as-cast",
    summary: "Unsafe `as` cast narrowing a union",
    hint: "Flag `as SomeType` casts that narrow a union (e.g. `value as string` when `value` is `string | null`). This silences the compiler but can cause runtime errors if the assumption is wrong. Prefer a type guard or explicit narrowing.",
  },
  {
    id: "ts/mutated-default-param",
    summary: "Mutated or object-valued default parameter",
    hint: "In JavaScript/TypeScript, default parameter values that are objects or arrays are re-evaluated each call, unlike Python. Watch for code that mutates the default value or relies on identity across calls.",
  },
];
