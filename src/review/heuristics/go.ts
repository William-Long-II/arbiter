import type { Heuristic } from "./index";

/**
 * Go-specific review hints.
 *
 * Text-level pointers for the LLM reviewer. The LLM should look for these
 * and stay silent when they are absent — these are not mandatory violations.
 */
export const HEURISTICS: Heuristic[] = [
  {
    id: "go/error-check-shadow",
    summary: "Error variable shadowing in short `if` declarations",
    hint: "Look for `if err := someCall(); err != nil { ... }` followed by a later use of `err` that was declared in an outer scope. The inner `err` shadows the outer one, which can mask real errors when both paths need to be checked.",
  },
  {
    id: "go/defer-in-loop",
    summary: "`defer` inside a loop",
    hint: "Check for `defer` statements inside `for` loops. Deferred calls accumulate until the surrounding function returns, not until the loop iteration ends, which can cause resource exhaustion (e.g., too many open file handles) or unexpected execution order.",
  },
  {
    id: "go/unchecked-goroutine",
    summary: "Unchecked goroutine launch with no error recovery",
    hint: "Review `go func()` launches that have no panic recovery and do not propagate errors back to the caller (e.g., via a channel or `sync.WaitGroup`). An unhandled panic in a goroutine terminates the whole process.",
  },
  {
    id: "go/slice-header-share",
    summary: "Slice header sharing after `append`",
    hint: "Flag code that stores a sub-slice and then appends to the original (or vice versa). When the original slice has capacity to grow, `append` may write into the backing array still shared by the sub-slice, causing silent data corruption. Use `copy` or `s[lo:hi:hi]` three-index slicing when slices must be independent.",
  },
  {
    id: "go/context-not-threaded",
    summary: "`context.Context` not threaded through call chain",
    hint: "Check whether new functions that call external services, databases, or long-running operations accept a `context.Context` as their first parameter. Omitting context means callers cannot cancel or set deadlines on these operations.",
  },
];
