import type { Heuristic } from "./index";

/**
 * Java-specific review hints.
 *
 * Text-level pointers for the LLM reviewer. The LLM should look for these
 * and stay silent when they are absent — these are not mandatory violations.
 */
export const HEURISTICS: Heuristic[] = [
  {
    id: "java/raw-types",
    summary: "Raw generic types",
    hint: "Look for raw use of generic types such as `List`, `Map`, or `Set` without type parameters. Raw types bypass generic type-safety and can cause `ClassCastException` at runtime. Prefer parameterized types or wildcards.",
  },
  {
    id: "java/static-mutable-state",
    summary: "Non-thread-safe static mutable state",
    hint: "Check for `static` fields that are mutable (non-final or mutable objects like `ArrayList`, `HashMap`) in classes that may be used from multiple threads (e.g., Spring beans, servlets). Unsynchronized mutation can cause race conditions.",
  },
  {
    id: "java/boxed-equals",
    summary: "`.equals` vs `==` on boxed types",
    hint: "Flag `==` comparisons between boxed types (`Integer`, `Long`, `Boolean`, etc.). The JVM caches only a small range of `Integer` values (−128 to 127); outside that range `==` compares references, not values. Always use `.equals()` or unbox explicitly.",
  },
  {
    id: "java/resource-not-autoclosed",
    summary: "Closeable resource not in try-with-resources",
    hint: "Review `InputStream`, `Connection`, `PreparedStatement`, and similar `Closeable` objects that are opened outside a try-with-resources block. Without `try (Resource r = ...) {}`, a resource may not be closed when an exception is thrown.",
  },
  {
    id: "java/instanceof-without-pattern",
    summary: "`instanceof` check without pattern binding",
    hint: "Look for the classic `if (x instanceof Foo) { Foo f = (Foo) x; ... }` pattern. Java 16+ pattern matching (`if (x instanceof Foo f) { ... }`) eliminates the redundant cast and the risk that a future refactor changes one side but not the other.",
  },
];
